/**
 * One-shot revert for #108 follow-up: a previous recompute pass
 * incorrectly back-filled `tick_metrics.ocean_unpaid_sat` for
 * historical rows using a `pool_block.reward × share_log_pct`
 * reconstruction. The reconstruction is wrong because share_log_pct
 * is the operator's TIDES window share at a moment in time, which
 * varies as the operator's mining activity varies; using a nearest-
 * known reading as a fallback for past blocks wildly over-credits
 * the operator on blocks before they were mining at full hashrate
 * (or before share_log was being captured at all).
 *
 * Operator caught the bogus line on the chart and asked for the
 * assumption rolled back. This service nulls the reconstructed
 * values out.
 *
 * Identification heuristic: any tick_at older than the
 * `_migrations.applied_at` of `0053_tick_metrics_extended_capture.sql`
 * (which added the `ocean_unpaid_sat` column) cannot have a real
 * Ocean-reported value - the column didn't exist. So any non-null
 * value on those rows must have been written by the recompute and
 * is safe to null. Post-0053 rows we leave alone: some may have
 * been reconstructed in cases where Ocean was unreachable at tick
 * time, but we have no marker to distinguish those from real
 * captures.
 *
 * Idempotent: runs every boot but only does work the first time;
 * subsequent boots find no rows to null.
 */

import type { Kysely } from 'kysely';

import type { Database } from '../state/types.js';

const COLUMN_INTRO_MIGRATION = '0053_tick_metrics_extended_capture.sql';

export interface OceanUnpaidCleanupDeps {
  readonly db: Kysely<Database>;
  readonly log?: (msg: string) => void;
}

export async function runOceanUnpaidCleanup(
  deps: OceanUnpaidCleanupDeps,
): Promise<void> {
  const log = deps.log ?? (() => undefined);

  const migration = await deps.db
    .selectFrom('_migrations')
    .select('applied_at')
    .where('name', '=', COLUMN_INTRO_MIGRATION)
    .executeTakeFirst();

  if (!migration) {
    log(
      `ocean-unpaid-cleanup: ${COLUMN_INTRO_MIGRATION} not found in _migrations - skipping`,
    );
    return;
  }

  const cutoffMs = migration.applied_at;
  const result = await deps.db
    .updateTable('tick_metrics')
    .set({ ocean_unpaid_sat: null })
    .where('tick_at', '<', cutoffMs)
    .where('ocean_unpaid_sat', 'is not', null)
    .executeTakeFirst();

  const affected = Number(result.numUpdatedRows ?? 0);
  if (affected > 0) {
    log(
      `ocean-unpaid-cleanup: nulled ${affected} pre-${new Date(cutoffMs).toISOString()} tick_metrics rows where ocean_unpaid_sat was reconstructed`,
    );
  }
}
