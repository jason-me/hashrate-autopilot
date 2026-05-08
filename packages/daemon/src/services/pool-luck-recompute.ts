/**
 * #108 follow-up: one-time historical recompute of
 * `tick_metrics.pool_blocks_24h_count`, `pool_blocks_7d_count`,
 * `pool_luck_24h`, `pool_luck_7d`.
 *
 * Why this exists: before #108 the per-tick counts came from
 * Ocean's `recent_blocks.slice(0, 15)` filtered to the trailing
 * window. The 15-block slice cap was binding for the 7-day window
 * (Ocean finds ~3/day, so 15 blocks covers only ~5 days), and any
 * blocks 5-7 days old at tick time were silently dropped from the
 * count. The luck line was therefore systematically biased low for
 * the entire historical region of the chart.
 *
 * The boot-time backfill in #108 populated the persistent
 * `pool_blocks` table with the full window's blocks. This service
 * walks every tick_metrics row that has a non-null pool_luck_7d and
 * recomputes both counts + both luck values from the now-truthful
 * pool_blocks table. Idempotent: subsequent boots see no change to
 * recompute and no-op cheaply.
 *
 * Bounded: only walks rows whose tick_at is at or after the
 * earliest pool_blocks timestamp - older ticks have no source data
 * to recompute against, so we leave their original (possibly biased
 * low) values alone. Operator can re-run a deeper backfill if they
 * want to fix those too.
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

  // Only ticks whose 7d window has SOME pool_blocks coverage. A tick
  // earlier than `earliestBlock + 7d` would still get a partial
  // window from pool_blocks - we don't actually know if blocks older
  // than `earliestBlock` exist in reality, so a recompute could
  // wrongly LOWER the count where the slice happened to capture a
  // block that's now missing from pool_blocks. Skipping those rows
  // is the conservative call.
  const earliestEligibleTick = earliestBlock + 7 * DAY_MS;

  let totalScanned = 0;
  let totalUpdated = 0;
  let cursorTickAt = earliestEligibleTick - 1;

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
      ])
      .where('tick_at', '>', cursorTickAt)
      .where('pool_luck_7d', 'is not', null)
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

      const luck24 = computePoolLuck({
        tickAt,
        countInWindow: count24,
        poolHashrateAvgPh: row.pool_hashrate_ph_avg_24h,
        networkDifficulty: row.network_difficulty,
        windowMs: DAY_MS,
        recentBlockTimestampsMs: ts24,
      });
      const luck7 = computePoolLuck({
        tickAt,
        countInWindow: count7,
        poolHashrateAvgPh: row.pool_hashrate_ph_avg_7d,
        networkDifficulty: row.network_difficulty,
        windowMs: 7 * DAY_MS,
        recentBlockTimestampsMs: ts7,
      });

      // Skip if nothing actually changes (idempotent re-runs no-op).
      if (
        row.pool_blocks_24h_count === count24 &&
        row.pool_blocks_7d_count === count7 &&
        approxEq(row.pool_luck_24h, luck24) &&
        approxEq(row.pool_luck_7d, luck7)
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

function approxEq(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  // Within 1e-6 - the recompute uses the same formula as the
  // original write, so any difference is float jitter.
  return Math.abs(a - b) < 1e-6;
}
