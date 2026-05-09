/**
 * GET /api/overpay-tuning  (#118)
 *
 * Returns the empirical "delivery vs. gap" curve over the trailing
 * 7 days. Powers the helper card next to the Overpay above fillable
 * input on Config -> Strategy -> Pricing.
 *
 * Methodology (rewritten 2026-05-09 after operator feedback - the
 * old "p95 of historical gap" approach answered the wrong question):
 *
 * 1. Pull rows from `tick_metrics` covering the last 7 days where
 *    bid + fillable + hashprice + max_bid are all non-null.
 * 2. Classify each row by regime:
 *    - 'capped'  - bid was effectively pinned to the cap; gap doesn't
 *                  reflect a free-market choice. Excluded.
 *    - 'under'   - bid was below fillable (negative gap), e.g. mid-edit.
 *                  Excluded.
 *    - 'tracking' - free-market normal case. Bucketed below.
 * 3. Bucket the 'tracking' rows by gap into 50 sat/PH/day bins from
 *    0 to 500, plus an open-ended 500+ bucket. For each bucket
 *    compute: tick count, average delivered_ph (null when count is
 *    too low to trust), and a counterfactual 30-day savings figure
 *    (what the operator would have paid if they'd bid
 *    `fillable + bucket_lower` on every tracking tick instead of
 *    their actual bid).
 *
 * Recommendation is computed CLIENT-SIDE from this bucket array:
 * the dashboard's slider picks a "fill rate target" (e.g. 95% of
 * `target_hashrate_ph`); the dashboard walks buckets low->high and
 * recommends the smallest bucket where avg_delivered >= target *
 * (slider/100). Pure-JS evaluation makes the slider drag feel
 * instant - the previous implementation refetched on every drag,
 * which felt unusably laggy.
 *
 * Why "delivery vs gap" is the right framing: the operator's
 * earlier offline analysis showed that at gap=100-199 sat/PH/day,
 * delivery was actually HIGHER than at the configured ~300. Lower
 * overpay didn't measurably lose fills. The old "p95 of historical
 * gap" answered "what gap did I run at most of the time" - which
 * tautologically returns ~current overpay. The new methodology
 * answers "what overpay would have sufficed to hit my target?" -
 * which is what the operator actually wants to know.
 */

import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../../state/types.js';
import type { ConfigRepo } from '../../state/repos/config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_DAYS = 7;
/** Floor for the recommendation: never recommend below this. Below
 *  ~tick_size the controller's edit deadband collapses and the
 *  Paused/Active oscillation hazard increases. */
const TICK_SIZE_SAT_PER_EH_DAY = 1_000;
/** Below this many tracking-regime ticks, the bucket curve is too
 *  noisy to recommend on. ~8 hours of 1-minute ticks. */
const MIN_TRACKING_TICKS = 500;
/** Below this many ticks in a bucket, the bucket's avg_delivered is
 *  treated as untrusted (null) so the client skips it when finding
 *  the lowest-gap candidate. */
const MIN_BUCKET_TICKS = 30;
/** Bucket width: 50 sat/PH/day = 50_000 sat/EH/day. Narrow enough
 *  to give granularity, wide enough that most buckets have ≥30
 *  ticks on a typical install. */
const BUCKET_WIDTH_SAT_PER_EH_DAY = 50_000;
/** Number of bounded buckets: 0-50, 50-100, ..., 450-500 (10
 *  buckets), plus one open-ended 500+ bucket = 11 total. */
const BOUNDED_BUCKET_COUNT = 10;
/** ~5 sat/PH/day fudge so a tick rounding artifact (bid 1-2 sat
 *  under the cap) isn't classified 'capped' and excluded. */
const CAP_DETECTION_TOLERANCE_SAT_PER_EH_DAY = 5_000;

export interface OverpayTuningBucket {
  /** Lower bound of the gap range, inclusive. */
  readonly gap_lower_sat_per_eh_day: number;
  /** Upper bound of the gap range, exclusive. Null on the open-ended top bucket. */
  readonly gap_upper_sat_per_eh_day: number | null;
  /** Number of tracking-regime ticks whose gap fell in this bucket. */
  readonly tick_count: number;
  /** Average delivered_ph across the ticks in this bucket. Null when
   *  tick_count is below the trust threshold. */
  readonly avg_delivered_ph: number | null;
  /** Counterfactual 30-day savings if we had bid `fillable + gap_lower`
   *  on every tracking tick instead of our actual bid. Always >= 0. */
  readonly hypothetical_30d_savings_sat: number;
}

export interface OverpayTuningResponse {
  /** Mirror of the live config value - dashboard uses this for the diff display. */
  readonly current_sat_per_eh_day: number;
  /** target_hashrate_ph from config. The slider's "fill rate target"
   *  multiplies this to derive the delivery threshold per bucket. */
  readonly target_hashrate_ph: number;
  readonly status: 'ready' | 'insufficient_history';
  readonly window_days: number;
  readonly eligible_ticks: number;
  readonly capped_ticks: number;
  readonly under_fillable_ticks: number;
  /** Total tick_metrics rows in the window (any regime). */
  readonly total_ticks: number;
  /** Empirical delivery curve. Empty array on insufficient_history. */
  readonly buckets: readonly OverpayTuningBucket[];
  /** Cap on the recommendation: never go below this. */
  readonly floor_sat_per_eh_day: number;
}

export interface OverpayTuningDeps {
  readonly db: Kysely<Database>;
  readonly configRepo: ConfigRepo;
}

interface TickRow {
  bid: number;
  fillable: number;
  hashprice: number;
  max_bid: number;
  delivered_ph: number | null;
}

export async function registerOverpayTuningRoute(
  app: FastifyInstance,
  deps: OverpayTuningDeps,
): Promise<void> {
  app.get('/api/overpay-tuning', async (): Promise<OverpayTuningResponse> => {
    const cfg = await deps.configRepo.get();
    const current = cfg?.overpay_sat_per_eh_day ?? 0;
    const target = cfg?.target_hashrate_ph ?? 0;
    const maxOverpay = cfg?.max_overpay_vs_hashprice_sat_per_eh_day ?? null;

    const sinceMs = Date.now() - SAMPLE_DAYS * DAY_MS;
    const rowsRes = await sql<TickRow>`
      SELECT
        our_primary_price_sat_per_eh_day AS bid,
        fillable_ask_sat_per_eh_day AS fillable,
        hashprice_sat_per_eh_day AS hashprice,
        max_bid_sat_per_eh_day AS max_bid,
        delivered_ph
      FROM tick_metrics
      WHERE tick_at >= ${sinceMs}
        AND our_primary_price_sat_per_eh_day IS NOT NULL
        AND fillable_ask_sat_per_eh_day IS NOT NULL
        AND hashprice_sat_per_eh_day IS NOT NULL
        AND max_bid_sat_per_eh_day IS NOT NULL
    `.execute(deps.db);
    const rows = rowsRes.rows;

    const tracking: Array<TickRow & { gap: number; effCap: number }> = [];
    let cappedTicks = 0;
    let underTicks = 0;
    for (const r of rows) {
      const gap = r.bid - r.fillable;
      if (gap < 0) {
        underTicks++;
        continue;
      }
      const dynCap =
        maxOverpay !== null ? r.hashprice + maxOverpay : Number.POSITIVE_INFINITY;
      const effCap = Math.min(r.max_bid, dynCap);
      if (r.bid >= effCap - CAP_DETECTION_TOLERANCE_SAT_PER_EH_DAY) {
        cappedTicks++;
        continue;
      }
      tracking.push({ ...r, gap, effCap });
    }

    if (tracking.length < MIN_TRACKING_TICKS) {
      return {
        current_sat_per_eh_day: current,
        target_hashrate_ph: target,
        status: 'insufficient_history',
        window_days: SAMPLE_DAYS,
        eligible_ticks: tracking.length,
        capped_ticks: cappedTicks,
        under_fillable_ticks: underTicks,
        total_ticks: rows.length,
        buckets: [],
        floor_sat_per_eh_day: TICK_SIZE_SAT_PER_EH_DAY,
      };
    }

    // Bucket layout: 0..50, 50..100, ..., 450..500, 500..inf.
    const buckets: OverpayTuningBucket[] = [];
    for (let i = 0; i <= BOUNDED_BUCKET_COUNT; i++) {
      const lower = i * BUCKET_WIDTH_SAT_PER_EH_DAY;
      const upper =
        i < BOUNDED_BUCKET_COUNT
          ? (i + 1) * BUCKET_WIDTH_SAT_PER_EH_DAY
          : null;
      const inBucket = tracking.filter((r) =>
        upper === null ? r.gap >= lower : r.gap >= lower && r.gap < upper,
      );

      const tickCount = inBucket.length;
      const avgDelivered =
        tickCount >= MIN_BUCKET_TICKS
          ? inBucket.reduce((sum, r) => sum + (r.delivered_ph ?? 0), 0) / tickCount
          : null;

      // Counterfactual savings: for ALL tracking ticks, compute
      // savings if we'd run at exactly `fillable + lower` (clamped
      // to the per-tick effective cap). Compared to the actual bid
      // the operator paid. Per-tick spend = bid * delivered_ph /
      // 1000 / 1440 (sat/EH/day -> sat per minute-tick).
      //
      // Savings is summed across the entire tracking sample (not
      // just this bucket's rows) because the recommendation applies
      // to ALL future ticks, not just the ticks that previously fell
      // in this bucket. Floored at 0 (a hypothetically-higher bid
      // doesn't represent a "loss" for this card's purpose).
      const lowerForCf = Math.max(lower, TICK_SIZE_SAT_PER_EH_DAY);
      let windowSavings = 0;
      for (const r of tracking) {
        const cfBid = Math.min(r.fillable + lowerForCf, r.effCap);
        const delivered = r.delivered_ph ?? 0;
        const factor = delivered / 1000 / 1440;
        const actual = r.bid * factor;
        const cf = cfBid * factor;
        windowSavings += Math.max(0, actual - cf);
      }
      const hypothetical_30d_savings_sat = Math.round(
        (windowSavings * 30) / SAMPLE_DAYS,
      );

      buckets.push({
        gap_lower_sat_per_eh_day: lower,
        gap_upper_sat_per_eh_day: upper,
        tick_count: tickCount,
        avg_delivered_ph: avgDelivered,
        hypothetical_30d_savings_sat,
      });
    }

    return {
      current_sat_per_eh_day: current,
      target_hashrate_ph: target,
      status: 'ready',
      window_days: SAMPLE_DAYS,
      eligible_ticks: tracking.length,
      capped_ticks: cappedTicks,
      under_fillable_ticks: underTicks,
      total_ticks: rows.length,
      buckets,
      floor_sat_per_eh_day: TICK_SIZE_SAT_PER_EH_DAY,
    };
  });
}
