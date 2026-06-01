/**
 * #241: boot-time backfill of synthetic tick_metrics rows across a
 * detected daemon-offline gap.
 *
 * Two problems this solves:
 *
 *   1. Difficulty-retarget markers: a retarget that happened *inside*
 *      the gap has no real tick_metrics row at its canonical time, so
 *      the chart's `prev vs next difficulty > 0.5%` marker detection
 *      finds the diff jump at the *first post-gap real tick*. The
 *      marker lands days late.
 *
 *   2. Pool-luck through the gap: `pool_luck_24h/7d/30d` lives in
 *      tick_metrics. With no rows in the gap, the chart linearly
 *      interpolates the luck line - so the operator sees a flat
 *      mauve segment across the gap even though pool_blocks_backfill
 *      has correctly populated pool blocks in the same window.
 *
 * Approach
 * --------
 *
 * Walk back through every retarget height (mod 2016) from chain tip
 * until the retarget block's canonical timestamp falls before the
 * gap; for each one inside the gap, record (canonical_time,
 * canonical_difficulty) from bitcoind. Then generate a synthetic tick
 * every {@link SYNTHETIC_INTERVAL_MS} across the gap, plus one tick
 * at each retarget's canonical timestamp. Assign each tick the
 * difficulty as-of its time (= the difficulty of the most recent
 * retarget at or before that time, falling back to prevTick's
 * difficulty for ticks before any in-gap retarget).
 *
 * The downstream {@link runPoolLuckRecompute} picks up the new rows
 * and populates `pool_blocks_*_count` and `pool_luck_*` for each
 * synthetic tick from the pool_blocks data - so the luck line
 * actually step-changes when pool blocks land in the gap, matching
 * the icons the chart already draws from pool_blocks_backfill.
 *
 * Without bitcoindClient
 * ----------------------
 *
 * Falls back to the legacy "one synthetic tick at the latest
 * retarget's nearest-pool-block estimate" behavior - the
 * pre-bitcoind retarget-backfill implementation. The per-tick
 * gap-fill is skipped entirely (we can't assign difficulty per
 * epoch without a way to find each retarget's canonical time).
 *
 * Idempotency
 * -----------
 *
 * Every run DELETEs `synthetic = 1` rows strictly inside the
 * detected gap before re-inserting. Re-runs replace stale entries
 * instead of accumulating them - and a previous boot's wrong-time
 * synthetic doesn't block re-detection (handled jointly by the
 * `synthetic = 0` filter on gap-boundary queries).
 */

import { sql, type Insertable, type Kysely, type Selectable } from 'kysely';

import type { BitcoindClient } from '@hashrate-autopilot/bitcoind-client';

import type { PoolBlocksRepo } from '../state/repos/pool_blocks.js';
import type { Database, TickMetricsTable } from '../state/types.js';

type TickMetricsRow = Selectable<TickMetricsTable>;

const RETARGET_INTERVAL = 2016;
const AVG_BLOCK_TIME_MS = 600_000;
const DIFFICULTY_THRESHOLD = 0.005;

/**
 * Synthetic tick cadence. 5 min aligns with the 1w chart bucket size
 * (so each visible bucket sees at least one synthetic). Finer would
 * be wasted; coarser would leave the bucket aggregation thin for
 * weeks-long gaps.
 */
const SYNTHETIC_INTERVAL_MS = 5 * 60_000;

/**
 * Skip "gaps" shorter than this. Normal poll variance from the
 * 60 s tick can leave a 2-3 min window where lastTick/prevTick
 * could plausibly bracket; we don't want to fill those with
 * synthetics.
 */
const MIN_GAP_MS = 10 * 60_000;

/**
 * Safety cap on retarget walk-back: if bitcoind returns plausible
 * timestamps every time, we'd stop at the first one before gapStart.
 * This guards against an unbounded loop if a degenerate response
 * arrives (very-stale node, time anomaly).
 */
const RETARGET_WALKBACK_CAP = 30;

interface RetargetEntry {
  readonly height: number;
  readonly timeMs: number;
  readonly difficulty: number;
}

export interface GapBackfillDeps {
  readonly db: Kysely<Database>;
  readonly poolBlocksRepo: PoolBlocksRepo;
  /**
   * When wired, per-tick gap-fill with correct difficulty per epoch.
   * Without it, falls back to the legacy single-synthetic-tick
   * behavior at the latest retarget's nearest-pool-block estimate.
   */
  readonly bitcoindClient?: BitcoindClient;
  readonly log?: (msg: string) => void;
}

export async function runGapBackfill(deps: GapBackfillDeps): Promise<void> {
  const { db, log = () => {} } = deps;

  // Gap detection anchors on REAL polled rows only (synthetic = 0).
  // A previous boot's backfill row must not be the gap-boundary
  // candidate - the synthetic carries post-retarget difficulty, so
  // including it would falsely make the diff appear stable and
  // short-circuit re-correction on the next boot.
  const lastTick = await db
    .selectFrom('tick_metrics')
    .selectAll()
    .where('synthetic', '=', 0)
    .orderBy('tick_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!lastTick || lastTick.network_difficulty == null) return;

  const prevTick = await db
    .selectFrom('tick_metrics')
    .selectAll()
    .where('synthetic', '=', 0)
    .where('tick_at', '<', lastTick.tick_at - 180_000)
    .where('network_difficulty', 'is not', null)
    .orderBy('tick_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!prevTick || prevTick.network_difficulty == null) return;

  const gapStart = prevTick.tick_at;
  const gapEnd = lastTick.tick_at;
  const gapMs = gapEnd - gapStart;
  if (gapMs < MIN_GAP_MS) return;

  // Always clear any stale synthetic rows in the detected gap before
  // re-inserting. Safe because real polled rows can't exist strictly
  // inside an outage - any row in (gapStart, gapEnd) with synthetic=1
  // is a previous run's insertion, possibly at a wrong-time estimate.
  const cleared = await db
    .deleteFrom('tick_metrics')
    .where('synthetic', '=', 1)
    .where('tick_at', '>', gapStart)
    .where('tick_at', '<', gapEnd)
    .executeTakeFirst();
  if (cleared.numDeletedRows > 0n) {
    log(`[gap-backfill] cleared ${cleared.numDeletedRows} stale synthetic tick(s) in (${new Date(gapStart).toISOString()}, ${new Date(gapEnd).toISOString()})`);
  }

  if (deps.bitcoindClient) {
    await runPerTickGapFill({
      db,
      bitcoindClient: deps.bitcoindClient,
      poolBlocksRepo: deps.poolBlocksRepo,
      log,
      prevTick,
      lastTick,
      gapStart,
      gapEnd,
      gapMs,
    });
  } else {
    await runLegacySingleMarker({
      db,
      poolBlocksRepo: deps.poolBlocksRepo,
      log,
      prevTick,
      lastTick,
      gapStart,
      gapEnd,
    });
  }
}

/**
 * Backwards-compat alias for callers that imported the previous name
 * before the gap-fill scope expansion. Removed in a follow-up cleanup.
 *
 * @deprecated use runGapBackfill
 */
export const runRetargetBackfill = runGapBackfill;

interface PerTickArgs {
  readonly db: Kysely<Database>;
  readonly bitcoindClient: BitcoindClient;
  readonly poolBlocksRepo: PoolBlocksRepo;
  readonly log: (msg: string) => void;
  readonly prevTick: TickMetricsRow;
  readonly lastTick: TickMetricsRow;
  readonly gapStart: number;
  readonly gapEnd: number;
  readonly gapMs: number;
}

async function runPerTickGapFill(args: PerTickArgs): Promise<void> {
  const { db, bitcoindClient, log, prevTick, gapStart, gapEnd, gapMs } = args;

  // Walk back through retarget heights from chain tip, collecting any
  // whose canonical block time falls inside the gap. We use poolBlocks'
  // max height as the chain-tip proxy (avoids one extra getblockcount
  // round-trip; the poll keeps it within a few blocks of tip).
  const maxHeight = await args.poolBlocksRepo.maxHeight();
  if (maxHeight == null) {
    log(`[gap-backfill] pool_blocks empty - cannot determine chain tip; skipping per-tick fill`);
    return;
  }
  const startHeight = Math.floor(maxHeight / RETARGET_INTERVAL) * RETARGET_INTERVAL;

  const retargets: RetargetEntry[] = [];
  let h = startHeight;
  for (let n = 0; n < RETARGET_WALKBACK_CAP && h > 0; n += 1) {
    let timeMs: number;
    let difficulty: number;
    try {
      // eslint-disable-next-line no-await-in-loop
      const hashResp = await bitcoindClient.batch<string>([
        { method: 'getblockhash', params: [h] },
      ]);
      const blockHash = hashResp[0];
      if (!blockHash) break;
      // Second round-trip for the header. Can't batch with the hash
      // call because the header request depends on the hash result.
      // eslint-disable-next-line no-await-in-loop
      const headerResp = await bitcoindClient.batch<{ time: number; difficulty: number }>([
        { method: 'getblockheader', params: [blockHash, true] },
      ]);
      const header = headerResp[0];
      if (!header) break;
      timeMs = header.time * 1000;
      difficulty = header.difficulty;
    } catch (err) {
      log(`[gap-backfill] bitcoind lookup for retarget block ${h} failed (${(err as Error).message}); aborting walk-back`);
      break;
    }
    if (timeMs < gapStart) break;
    if (timeMs <= gapEnd) {
      retargets.push({ height: h, timeMs, difficulty });
    }
    h -= RETARGET_INTERVAL;
  }
  retargets.sort((a, b) => a.timeMs - b.timeMs);

  // Generate synthetic timestamps every SYNTHETIC_INTERVAL_MS across
  // the gap, plus a tick at each retarget's canonical time. The Set
  // dedupes the case where a regular interval lands within a few
  // seconds of a retarget canonical (unlikely but possible).
  const timestamps = new Set<number>();
  for (let t = gapStart + SYNTHETIC_INTERVAL_MS; t < gapEnd; t += SYNTHETIC_INTERVAL_MS) {
    timestamps.add(t);
  }
  for (const r of retargets) {
    timestamps.add(r.timeMs);
  }
  if (timestamps.size === 0) return;

  const ordered = Array.from(timestamps).sort((a, b) => a - b);

  // Assign difficulty per timestamp: the post-retarget difficulty of
  // the most recent retarget at-or-before T, falling back to prevTick's
  // (last pre-gap) difficulty for ticks before any in-gap retarget.
  const prevDiff = prevTick.network_difficulty;
  const diffForTimestamp = (t: number): number | null => {
    let diff: number | null = prevDiff;
    for (const r of retargets) {
      if (r.timeMs <= t) diff = r.difficulty;
      else break;
    }
    return diff;
  };

  // Build the inserts. Strip operator-status fields (delivered_ph,
  // bid prices, balances, oracle reading) - the operator was offline
  // and inheriting the template's last-pre-gap values would falsely
  // imply the daemon was up. Keep config snapshots (target/floor,
  // deadband, run/action mode) because they really were that value
  // throughout the gap.
  const rows: Insertable<TickMetricsTable>[] = ordered.map((t) => ({
    tick_at: t,
    delivered_ph: 0,
    target_ph: prevTick.target_ph,
    floor_ph: prevTick.floor_ph,
    owned_bid_count: 0,
    unknown_bid_count: 0,
    our_primary_price_sat_per_eh_day: null,
    best_bid_sat_per_eh_day: null,
    best_ask_sat_per_eh_day: null,
    fillable_ask_sat_per_eh_day: null,
    hashprice_sat_per_eh_day: null,
    max_bid_sat_per_eh_day: null,
    available_balance_sat: null,
    total_balance_sat: null,
    datum_hashrate_ph: null,
    ocean_hashrate_ph: null,
    share_log_pct: null,
    spend_sat: null,
    primary_bid_consumed_sat: null,
    network_difficulty: diffForTimestamp(t),
    estimated_block_reward_sat: null,
    pool_hashrate_ph: null,
    pool_active_workers: null,
    braiins_total_deposited_sat: null,
    braiins_total_spent_sat: null,
    ocean_unpaid_sat: null,
    // pool_blocks_*_count, pool_hashrate_ph_avg_*, pool_luck_*,
    // paid_total_sat all stay null - runPoolLuckRecompute fills them
    // immediately after this service.
    paid_total_sat: null,
    btc_usd_price: null,
    btc_usd_price_source: null,
    primary_bid_last_pause_reason: null,
    primary_bid_fee_paid_sat: null,
    primary_bid_fee_rate_pct: null,
    bid_edit_deadband_pct: prevTick.bid_edit_deadband_pct,
    pool_blocks_24h_count: null,
    pool_blocks_7d_count: null,
    pool_hashrate_ph_avg_24h: null,
    pool_hashrate_ph_avg_7d: null,
    pool_luck_24h: null,
    pool_luck_7d: null,
    pool_luck_30d: null,
    pool_blocks_30d_count: null,
    pool_hashrate_ph_avg_30d: null,
    braiins_reachable: 0,
    run_mode: prevTick.run_mode,
    action_mode: prevTick.action_mode,
    synthetic: 1,
  }));

  // SQLite's default parameter cap is 999. Each row uses ~42 params,
  // so 20 rows per batch (840 params) stays comfortably below.
  const BATCH = 20;
  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insertInto('tick_metrics').values(rows.slice(i, i + BATCH)).execute();
  }
  /* eslint-enable no-await-in-loop */

  const gapHrs = (gapMs / 3_600_000).toFixed(1);
  log(`[gap-backfill] inserted ${rows.length} synthetic tick(s) across ${gapHrs}h gap; ${retargets.length} retarget(s) embedded (heights: ${retargets.map((r) => r.height).join(', ') || 'none'})`);
}

interface LegacySingleMarkerArgs {
  readonly db: Kysely<Database>;
  readonly poolBlocksRepo: PoolBlocksRepo;
  readonly log: (msg: string) => void;
  readonly prevTick: TickMetricsRow;
  readonly lastTick: TickMetricsRow;
  readonly gapStart: number;
  readonly gapEnd: number;
}

/**
 * Pre-bitcoind fallback: one synthetic tick at the latest retarget's
 * nearest-pool-block-estimated time. Same behavior as
 * `runRetargetBackfill` before the per-tick gap-fill was added.
 *
 * Difficulty-stability short-circuit only applies here - in the
 * per-tick path, the gap fill happens regardless of whether the
 * pre/post difficulty diff is large, because we want the synthetic
 * ticks for pool-luck recompute too.
 */
async function runLegacySingleMarker(args: LegacySingleMarkerArgs): Promise<void> {
  const { db, poolBlocksRepo, log, prevTick, lastTick, gapStart, gapEnd } = args;

  const oldDiff = prevTick.network_difficulty!;
  const newDiff = lastTick.network_difficulty!;
  if (Math.abs(newDiff - oldDiff) / oldDiff < DIFFICULTY_THRESHOLD) return;

  const maxHeight = await poolBlocksRepo.maxHeight();
  if (maxHeight == null) return;
  const latestRetargetHeight = Math.floor(maxHeight / RETARGET_INTERVAL) * RETARGET_INTERVAL;

  const nearestBlock = await db
    .selectFrom('pool_blocks')
    .select(['height', 'timestamp_ms'])
    .orderBy(sql`ABS(height - ${latestRetargetHeight})`)
    .limit(1)
    .executeTakeFirst();
  if (!nearestBlock) return;

  const estimatedRetargetMs =
    nearestBlock.timestamp_ms - (nearestBlock.height - latestRetargetHeight) * AVG_BLOCK_TIME_MS;
  if (estimatedRetargetMs <= gapStart || estimatedRetargetMs >= gapEnd) {
    log(`[gap-backfill] legacy fallback: estimated retarget at ${new Date(estimatedRetargetMs).toISOString()} outside gap; skipping`);
    return;
  }

  const templateTick = await db
    .selectFrom('tick_metrics')
    .selectAll()
    .where('synthetic', '=', 0)
    .where('tick_at', '<=', gapStart)
    .orderBy('tick_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!templateTick) return;

  const { id: _id, synthetic: _syn, ...rest } = templateTick;
  await db
    .insertInto('tick_metrics')
    .values({
      ...rest,
      tick_at: estimatedRetargetMs,
      network_difficulty: newDiff,
      synthetic: 1,
    })
    .execute();

  const pctChange = (((newDiff - oldDiff) / oldDiff) * 100).toFixed(2);
  log(`[gap-backfill] legacy fallback: inserted synthetic tick at ${new Date(estimatedRetargetMs).toISOString()} for retarget at height ${latestRetargetHeight} (difficulty ${pctChange > '0' ? '+' : ''}${pctChange}%)`);
}
