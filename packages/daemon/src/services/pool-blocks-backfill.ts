/**
 * #108: boot-time backfill of Ocean's pool-blocks ledger.
 *
 * Without this, a fresh install starts with an empty `pool_blocks`
 * table and the dashboard's historical pool-luck plot is blank for
 * the entire 7-day pre-install window. Ocean's `/v1/blocks` endpoint
 * has the data the whole time; we just need to fetch it once on
 * first boot.
 *
 * Idempotent: subsequent boots see the table populated and skip; a
 * boot after a long downtime ( > 7 days since the latest known block)
 * does another pass to fill the gap. The repo's upsert is
 * conflict-on-height so re-running is harmless.
 *
 * Bounded: caps at `MAX_PAGES * PAGE_SIZE` blocks to avoid hammering
 * Ocean if the DB is in an unexpected state. Stops early once we've
 * walked past `LOOKBACK_DAYS` worth of history.
 */

import type { OceanClient } from './ocean.js';
import type { PoolBlocksRepo } from '../state/repos/pool_blocks.js';

const PAGE_SIZE = 30;
// 12 × 30 = 360 blocks. At Ocean's 2026-05 find rate (~3/day) that's
// ~120 days of headroom on the cap; at the worst case observed in
// 2024-12 (~9/day) it's still ~40. The lookback floor below stops
// us early so steady-state runs don't actually paginate this deep.
const MAX_PAGES = 12;
const LOOKBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PoolBlocksBackfillDeps {
  readonly oceanClient: OceanClient;
  readonly poolBlocksRepo: PoolBlocksRepo;
  readonly log?: (msg: string) => void;
  readonly now?: () => number;
}

export async function runPoolBlocksBackfill(deps: PoolBlocksBackfillDeps): Promise<void> {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());

  const earliest = await deps.poolBlocksRepo.earliestTimestampMs().catch(() => null);
  const cutoff = now() - LOOKBACK_DAYS * DAY_MS;

  // Skip when we already have data older than the lookback window.
  if (earliest !== null && earliest <= cutoff) {
    return;
  }

  log(`pool_blocks: backfill starting (earliest=${earliest === null ? 'empty' : new Date(earliest).toISOString()}, cutoff=${new Date(cutoff).toISOString()})`);

  let totalUpserted = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const blocks = await deps.oceanClient.fetchBlocksPage(page, PAGE_SIZE);
    if (blocks.length === 0) break;

    const valid = blocks.filter((b) => b.timestamp_ms > 0 && b.height > 0);
    if (valid.length === 0) break;

    await deps.poolBlocksRepo.upsertMany(
      valid.map((b) => ({
        height: b.height,
        block_hash: b.block_hash,
        timestamp_ms: b.timestamp_ms,
        total_reward_sat: b.total_reward_sat,
        subsidy_sat: b.subsidy_sat,
        fees_sat: b.fees_sat,
        worker: b.worker || null,
        username: b.username || null,
      })),
      now(),
    );
    totalUpserted += valid.length;

    // If the oldest block on this page is already older than the
    // lookback cutoff, the next page would be even older - stop.
    const oldestOnPage = valid[valid.length - 1]!.timestamp_ms;
    if (oldestOnPage <= cutoff) break;
  }

  log(`pool_blocks: backfill upserted ${totalUpserted} block(s)`);
}
