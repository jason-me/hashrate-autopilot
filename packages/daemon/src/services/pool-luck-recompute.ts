/**
 * #108 follow-up: one-time historical recompute of
 * `tick_metrics.pool_blocks_24h_count`, `pool_blocks_7d_count`,
 * `pool_luck_24h`, `pool_luck_7d`, `paid_total_sat`, and
 * `ocean_unpaid_sat`.
 *
 * Why this exists:
 *
 * 1. Before #108 the per-tick counts came from Ocean's
 *    `recent_blocks.slice(0, 15)` filtered to the trailing window.
 *    The 15-block slice cap was binding for the 7-day window (Ocean
 *    finds ~3/day, so 15 blocks covers only ~5 days), so any blocks
 *    5-7 days old at tick time were silently dropped. The historical
 *    luck line was systematically biased low.
 *
 * 2. `network_difficulty` and `pool_hashrate_ph_avg_*` only started
 *    being captured per-tick at migrations 0053 / 0056. Older ticks
 *    have null inputs and the original write skipped them - even
 *    though both values are recoverable: difficulty changes only on
 *    retarget (~2 weeks), pool hashrate drifts slowly. We backfill
 *    those inputs from the nearest non-null tick at recompute time
 *    so older ticks become computable too.
 *
 * Together: this service walks every tick_metrics row whose 7d
 * window is covered by `pool_blocks`, gathers the formula inputs
 * (using nearest-non-null fallbacks where the row's own value is
 * null), and writes the recomputed counts + luck back.
 *
 * Bonus pass: cumulative `paid_total_sat` (exact - from
 * `reward_events.value_sat` running sum) and `ocean_unpaid_sat`
 * (approximate - sum of `pool_block.total_reward_sat ×
 * share_log_pct_at_block` minus cumulative payouts up to that tick).
 * Both filled only on rows where the column is currently null, so
 * Ocean's actual reported `unpaid_sat` stays the source of truth on
 * rows that already have it.
 *
 * Idempotent: subsequent boots see no change and no-op cheaply.
 */

import type { Kysely } from 'kysely';

import { computePoolLuck } from './pool-luck.js';
import type { PoolBlocksRepo } from '../state/repos/pool_blocks.js';
import type { Database } from '../state/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;

export interface PoolLuckRecomputeDeps {
  readonly db: Kysely<Database>;
  readonly poolBlocksRepo: PoolBlocksRepo;
  readonly log?: (msg: string) => void;
}

export async function runPoolLuckRecompute(deps: PoolLuckRecomputeDeps): Promise<void> {
  const log = deps.log ?? (() => undefined);

  const earliestBlock = await deps.poolBlocksRepo.earliestTimestampMs().catch(() => null);
  if (earliestBlock === null) {
    log('pool-luck-recompute: pool_blocks empty, nothing to recompute');
    return;
  }

  // Eligible window: ticks whose 7d window starts at or after the
  // earliest pool_block we have. Below this, the count would be
  // partial-by-pool_blocks-coverage rather than real-pool-find
  // history, and we'd lower the count to a wrong value. Conservative.
  const earliestEligibleTick = earliestBlock + 7 * DAY_MS;

  // Pre-load nearest-non-null lookup tables for the formula inputs
  // that older ticks predate. Both are slow-moving (difficulty
  // retargets every ~2 weeks; pool hashrate drifts a few % per day),
  // so a nearest-by-time backfill is a perfectly reasonable
  // reconstruction for the chart.
  const [diffSeries, ph24Series, ph7Series] = await Promise.all([
    loadSeries(deps.db, 'network_difficulty'),
    loadSeries(deps.db, 'pool_hashrate_ph_avg_24h'),
    loadSeries(deps.db, 'pool_hashrate_ph_avg_7d'),
  ]);

  if (diffSeries.length === 0 || ph24Series.length === 0 || ph7Series.length === 0) {
    log(
      `pool-luck-recompute: insufficient input series (diff=${diffSeries.length}, ph24=${ph24Series.length}, ph7=${ph7Series.length}); skipping`,
    );
    return;
  }

  // Pre-build a credits timeline for ocean_unpaid_sat reconstruction.
  // Each pool_block adds (reward × operator_share_at_block_time) to
  // the operator's running unpaid balance; each on-chain payout
  // (reward_events) draws it back down. Both lists are pre-sorted
  // ascending so we advance pointers per-tick in O(1).
  const shareLogSeries = await loadSeries(deps.db, 'share_log_pct');
  const blockCredits = await buildBlockCredits(deps.db, shareLogSeries);
  const payouts = await loadPayouts(deps.db);

  let totalScanned = 0;
  let totalUpdated = 0;
  let cursorTickAt = earliestEligibleTick - 1;
  let cumPaidSat = 0;
  let cumCreditSat = 0;
  let creditPtr = 0;
  let payoutPtr = 0;

  /* eslint-disable no-await-in-loop */
  while (true) {
    const batch = await deps.db
      .selectFrom('tick_metrics')
      .select([
        'id',
        'tick_at',
        'pool_blocks_24h_count',
        'pool_blocks_7d_count',
        'pool_luck_24h',
        'pool_luck_7d',
        'pool_hashrate_ph_avg_24h',
        'pool_hashrate_ph_avg_7d',
        'network_difficulty',
        'paid_total_sat',
        'ocean_unpaid_sat',
      ])
      .where('tick_at', '>', cursorTickAt)
      .orderBy('tick_at', 'asc')
      .limit(BATCH_SIZE)
      .execute();

    if (batch.length === 0) break;

    for (const row of batch) {
      cursorTickAt = row.tick_at;
      totalScanned += 1;

      const tickAt = row.tick_at;
      const [count24, count7, ts24, ts7] = await Promise.all([
        deps.poolBlocksRepo.countInWindow(tickAt - DAY_MS, tickAt),
        deps.poolBlocksRepo.countInWindow(tickAt - 7 * DAY_MS, tickAt),
        deps.poolBlocksRepo.timestampsInWindow(tickAt - DAY_MS, tickAt),
        deps.poolBlocksRepo.timestampsInWindow(tickAt - 7 * DAY_MS, tickAt),
      ]);

      const networkDifficulty = row.network_difficulty ?? nearest(diffSeries, tickAt);
      const ph24 = row.pool_hashrate_ph_avg_24h ?? nearest(ph24Series, tickAt);
      const ph7 = row.pool_hashrate_ph_avg_7d ?? nearest(ph7Series, tickAt);

      const luck24 = computePoolLuck({
        tickAt,
        countInWindow: count24,
        poolHashrateAvgPh: ph24,
        networkDifficulty,
        windowMs: DAY_MS,
        recentBlockTimestampsMs: ts24,
      });
      const luck7 = computePoolLuck({
        tickAt,
        countInWindow: count7,
        poolHashrateAvgPh: ph7,
        networkDifficulty,
        windowMs: 7 * DAY_MS,
        recentBlockTimestampsMs: ts7,
      });

      // Advance the credit/payout cursors past anything that
      // happened on or before this tick. Both lists are sorted
      // ascending so this runs in amortized O(1) per row across the
      // whole scan.
      while (creditPtr < blockCredits.length && blockCredits[creditPtr]!.at_ms <= tickAt) {
        cumCreditSat += blockCredits[creditPtr]!.credit_sat;
        creditPtr += 1;
      }
      while (payoutPtr < payouts.length && payouts[payoutPtr]!.at_ms <= tickAt) {
        cumPaidSat += payouts[payoutPtr]!.value_sat;
        payoutPtr += 1;
      }

      // paid_total_sat: exact - cumulative on-chain payouts. Always
      // reconstructible. Overwriting is safe because the formula
      // matches the original write-side (see RewardEventsRepo).
      const paidTotal = cumPaidSat;

      // ocean_unpaid_sat: only fill where the row's value is null.
      // For rows where Ocean already reported a value, that's the
      // source of truth and we leave it alone. The reconstructed
      // value is approximate (TIDES has internal accounting we don't
      // model) but produces a usable line on the historical chart.
      const reconstructedUnpaid = Math.max(0, Math.round(cumCreditSat - cumPaidSat));
      const oceanUnpaid =
        row.ocean_unpaid_sat !== null ? row.ocean_unpaid_sat : reconstructedUnpaid;

      // Skip if nothing actually changes (idempotent re-runs no-op).
      if (
        row.pool_blocks_24h_count === count24 &&
        row.pool_blocks_7d_count === count7 &&
        approxEq(row.pool_luck_24h, luck24) &&
        approxEq(row.pool_luck_7d, luck7) &&
        row.paid_total_sat === paidTotal &&
        row.ocean_unpaid_sat === oceanUnpaid
      ) {
        continue;
      }

      await deps.db
        .updateTable('tick_metrics')
        .set({
          pool_blocks_24h_count: count24,
          pool_blocks_7d_count: count7,
          pool_luck_24h: luck24,
          pool_luck_7d: luck7,
          paid_total_sat: paidTotal,
          ocean_unpaid_sat: oceanUnpaid,
        })
        .where('id', '=', row.id)
        .execute();
      totalUpdated += 1;
    }
  }
  /* eslint-enable no-await-in-loop */

  log(
    `pool-luck-recompute: scanned ${totalScanned}, updated ${totalUpdated} tick_metrics row(s) using pool_blocks data`,
  );
}

/**
 * Pre-load every non-null (tick_at, value) pair for one column.
 * Sorted by tick_at ascending. Used by `nearest()` for O(log N)
 * lookups during the recompute scan.
 */
async function loadSeries(
  db: Kysely<Database>,
  column:
    | 'network_difficulty'
    | 'pool_hashrate_ph_avg_24h'
    | 'pool_hashrate_ph_avg_7d'
    | 'share_log_pct',
): Promise<readonly { readonly tick_at: number; readonly value: number }[]> {
  const rows = await db
    .selectFrom('tick_metrics')
    .select(['tick_at', column])
    .where(column, 'is not', null)
    .orderBy('tick_at', 'asc')
    .execute();
  return rows.map((r) => ({ tick_at: r.tick_at, value: (r as Record<string, number>)[column]! }));
}

/**
 * Binary search for the (tick_at, value) entry whose tick_at is
 * closest to the target. Used to fill missing per-tick inputs from
 * the nearest-known sample. Both inputs (difficulty + pool hashrate
 * average) are slow-moving so nearest-by-time is a faithful
 * reconstruction.
 */
function nearest(
  series: readonly { readonly tick_at: number; readonly value: number }[],
  target: number,
): number | null {
  if (series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid]!.tick_at < target) lo = mid + 1;
    else hi = mid;
  }
  // lo is now the smallest index with tick_at >= target. Check the
  // entry just before it for actually-closer time delta.
  const above = series[lo]!;
  if (lo === 0) return above.value;
  const below = series[lo - 1]!;
  return target - below.tick_at <= above.tick_at - target ? below.value : above.value;
}

function approxEq(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  // Within 1e-6 - the recompute uses the same formula as the
  // original write, so any difference is float jitter.
  return Math.abs(a - b) < 1e-6;
}

/**
 * Build (block_timestamp, operator_credit_sat) pairs for every
 * pool_block we have. Operator's credit on a block = block reward
 * × operator's share_log_pct at the block's timestamp / 100.
 * share_log_pct is looked up nearest-by-time from tick_metrics so
 * blocks before the share_log capture started use the closest
 * available reading.
 */
async function buildBlockCredits(
  db: Kysely<Database>,
  shareLogSeries: readonly { readonly tick_at: number; readonly value: number }[],
): Promise<readonly { readonly at_ms: number; readonly credit_sat: number }[]> {
  if (shareLogSeries.length === 0) return [];
  const blocks = await db
    .selectFrom('pool_blocks')
    .select(['timestamp_ms', 'total_reward_sat'])
    .orderBy('timestamp_ms', 'asc')
    .execute();
  return blocks.map((b) => {
    const sharePct = nearest(shareLogSeries, b.timestamp_ms) ?? 0;
    return {
      at_ms: b.timestamp_ms,
      credit_sat: (b.total_reward_sat * sharePct) / 100,
    };
  });
}

/**
 * Cumulative-payouts source for the unpaid + paid_total recompute.
 * Excludes reorged rows; the on-chain ledger is the ground truth.
 */
async function loadPayouts(
  db: Kysely<Database>,
): Promise<readonly { readonly at_ms: number; readonly value_sat: number }[]> {
  const rows = await db
    .selectFrom('reward_events')
    .select(['detected_at', 'value_sat'])
    .where('reorged', '=', 0)
    .orderBy('detected_at', 'asc')
    .execute();
  return rows.map((r) => ({ at_ms: r.detected_at, value_sat: r.value_sat }));
}
