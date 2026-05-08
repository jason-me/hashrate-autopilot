/**
 * Tiny read-only repo for `reward_events` aggregations consumed by
 * the per-tick observer (#102).
 *
 * Writes happen in payout-observer.ts (it owns the polling +
 * insertion path); this repo only exposes read methods needed by
 * tick_metrics or the dashboard. Keeping the read side here avoids
 * a circular import between observe and payout-observer.
 */

import type { Kysely } from 'kysely';

import type { Database } from '../types.js';

export class RewardEventsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Cumulative sum of `value_sat` for non-reorged reward events with
   * `detected_at <= sinceMs`. Used as `paid_total_sat` per tick - the
   * monotonically non-decreasing partner to `ocean_unpaid_sat` so the
   * lifetime-earnings line on the chart survives payout cliffs.
   *
   * Returns 0 when there are no rows (fresh install / payout_source =
   * 'none' / address never paid). Caller decides whether to coerce 0
   * to null (e.g. when no payout observer is wired so the metric is
   * structurally meaningless).
   */
  async sumPaidUpTo(throughMs: number): Promise<number> {
    const row = await this.db
      .selectFrom('reward_events')
      .select((eb) => eb.fn.sum<number>('value_sat').as('s'))
      .where('reorged', '=', 0)
      .where('detected_at', '<=', throughMs)
      .executeTakeFirst();
    return Number(row?.s ?? 0);
  }
}
