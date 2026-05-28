/**
 * GET /api/metrics?range=<preset>
 *
 * Returns the time series of tick metrics for the hashrate chart. The
 * `range` query param is one of the presets exported from
 * `@hashrate-autopilot/shared`:
 *
 *   6h | 12h | 24h | 1w | 1m | 1y | all
 *
 * The server picks the aggregation bucket per preset (0 for raw,
 * otherwise a fixed ms window) and returns pre-aggregated averages so
 * the client never renders hundreds of thousands of raw points at long
 * ranges. Default is `24h`.
 *
 * Legacy: `since=<ms>` is still accepted for backwards-compat with any
 * ad-hoc callers, and forces raw (no aggregation) output.
 */

import type { FastifyInstance } from 'fastify';

import {
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  pickBucketForSpan,
  type ChartRange,
} from '@hashrate-autopilot/shared';

import type { HttpServerDeps } from '../server.js';

const EH_PER_PH = 1000;

export interface MetricPoint {
  readonly tick_at: number;
  readonly delivered_ph: number;
  readonly target_ph: number;
  readonly floor_ph: number;
  readonly our_primary_price_sat_per_ph_day: number | null;
  readonly best_bid_sat_per_ph_day: number | null;
  readonly best_ask_sat_per_ph_day: number | null;
  readonly fillable_ask_sat_per_ph_day: number | null;
  readonly hashprice_sat_per_ph_day: number | null;
  readonly max_bid_sat_per_ph_day: number | null;
  readonly available_balance_sat: number | null;
  readonly total_balance_sat: number | null;
  /**
   * Hashrate Datum reports for its own connected workers, PH/s.
   * Null when the Datum integration is disabled, the poll failed
   * for that tick, or the tick predates migration 0029.
   */
  readonly datum_hashrate_ph: number | null;
  /**
   * Hashrate Ocean credits to the operator's payout address - the
   * `hashrate_300s` field from `/v1/user_hashrate` (5-min sliding
   * window), in PH/s. Null when Ocean isn't configured, the poll
   * failed, or the tick predates migration 0035.
   */
  readonly ocean_hashrate_ph: number | null;
  /**
   * Ocean `share_log` percentage at this tick (e.g. 0.0182 for
   * 0.0182%) - our slice of the pool's TIDES window, sampled from
   * the same `/statsnap` + `/pool_stat` fetch that supplies
   * `hashprice_sat_per_ph_day`. Drives the optional violet `% of
   * Ocean` overlay on the Hashrate chart's right Y-axis. Null when
   * Ocean isn't configured, the poll failed, or the tick predates
   * migration 0048.
   */
  readonly share_log_pct: number | null;
  /**
   * Primary owned bid's cumulative `amount_consumed_sat` at this tick
   * (sat). Per-tick deltas give the authoritative actual-spend rate
   * (independent of our pay-your-bid `spend_sat` model). Null on pre-
   * migration rows and on ticks without a primary owned bid. See
   * migration 0041.
   */
  readonly primary_bid_consumed_sat: number | null;
  // #93: secondary-axis series exposed via /api/metrics so the chart
  // dropdown has data to plot. Each is nullable - aggregation buckets
  // average over rows where the field is present.
  readonly network_difficulty: number | null;
  readonly pool_hashrate_ph: number | null;
  readonly estimated_block_reward_sat: number | null;
  readonly btc_usd_price: number | null;
  readonly ocean_unpaid_sat: number | null;
  /** #102: cumulative on-chain payout total at tick, sat. */
  readonly paid_total_sat: number | null;
  // #92: pool block counts - input to the chart's pool-luck plot.
  readonly pool_blocks_24h_count: number | null;
  readonly pool_blocks_7d_count: number | null;
  /**
   * Trailing 24h / 7d mean of pool_hashrate_ph ending at this tick.
   * Used as the denominator of the chart's matching luck window so
   * the numerator's window (block count over the same N days) and
   * the denominator's window line up. Null on rows older than
   * migration 0056 - the chart falls back to its prior client-side
   * smoothing on those rows.
   */
  readonly pool_hashrate_ph_avg_24h: number | null;
  readonly pool_hashrate_ph_avg_7d: number | null;
  /**
   * Gap-based pool luck (24h / 7d) computed per tick on the daemon
   * side. `luck = (600 / pool_share) / time_since_last_pool_block`.
   * Decays continuously between finds, jumps on each find. Replaces
   * the prior client-side "count_in_window / poisson_expected" calc.
   */
  readonly pool_luck_24h: number | null;
  readonly pool_luck_7d: number | null;
  readonly pool_luck_30d: number | null;
  readonly pool_blocks_30d_count: number | null;
  readonly pool_hashrate_ph_avg_30d: number | null;
  readonly braiins_reachable: number | null;
  /**
   * #220: per-bucket profit components, computed in the route from
   * consecutive aggregated rows (NOT a per-tick instantaneous value).
   *
   * Semantics for a given bucket i:
   *   revenue_sat = (ocean_unpaid_sat[i] - ocean_unpaid_sat[i-1])
   *               + (paid_total_sat[i]    - paid_total_sat[i-1])
   *   cost_sat    =  primary_bid_consumed_sat[i]
   *               -  primary_bid_consumed_sat[i-1]
   *   profit_sat  = revenue_sat - cost_sat
   *
   * - First bucket has all three null (no prior to delta against).
   * - Any bucket where the relevant cumulative input is null at either
   *   end gets the component null (pre-migration tail, transient
   *   observer gaps).
   * - A negative cost_sat delta (primary-bid swap reset the counter)
   *   yields cost_sat = null and therefore profit_sat = null. We don't
   *   know the actual spend across the swap and would rather show a
   *   gap than inflate profit. Documented landmine for this bucket
   *   only; subsequent buckets reference the new counter and resume
   *   normal accounting.
   * - When a payout crystallizes mid-bucket, ocean_unpaid_sat drops
   *   and paid_total_sat rises by the same amount; revenue_sat sums
   *   to the actual share work done in the bucket.
   */
  readonly profit_sat: number | null;
  readonly revenue_sat: number | null;
  readonly cost_sat: number | null;
}

export async function registerMetricsRoute(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.get<{ Querystring: { range?: string; since?: string; until?: string; span?: string; limit?: string } }>(
    '/api/metrics',
    async (req): Promise<{ points: MetricPoint[]; range: ChartRange | null }> => {
      const nowMs = Date.now();
      const limit = clamp(Number.parseInt(req.query.limit ?? '', 10) || 5000, 10, 10_000);

      // #169: arbitrary viewport path: since=<ms>&until=<ms>
      // Optional span=<ms> overrides the bucket-selection span so the
      // caller can fetch a wider range (for pan buffering) without
      // changing the aggregation granularity.
      const parsedSince = Number.parseInt(req.query.since ?? '', 10);
      const parsedUntil = Number.parseInt(req.query.until ?? '', 10);
      if (
        !req.query.range &&
        Number.isFinite(parsedSince) && parsedSince >= 0 &&
        Number.isFinite(parsedUntil) && parsedUntil > parsedSince
      ) {
        const fetchSpanMs = parsedUntil - parsedSince;
        const parsedSpan = Number.parseInt(req.query.span ?? '', 10);
        let bucketSpanMs = Number.isFinite(parsedSpan) && parsedSpan > 0 ? parsedSpan : fetchSpanMs;
        const firstTick = await deps.tickMetricsRepo.firstTickAt();
        if (firstTick !== null && parsedSince < firstTick) {
          bucketSpanMs = Math.min(bucketSpanMs, parsedUntil - firstTick);
        }
        const bucketMs = pickBucketForSpan(bucketSpanMs);
        const rows = await deps.tickMetricsRepo.listAggregated(
          parsedSince, bucketMs, limit, parsedUntil,
        );
        return { points: withProfit(rows.map(toMetricPoint)), range: null };
      }

      // Legacy path: since=<ms> alone -> raw rows from that timestamp.
      if (!req.query.range && Number.isFinite(parsedSince) && parsedSince > 0) {
        const rows = await deps.tickMetricsRepo.listSince(parsedSince, limit);
        return { points: withProfit(rows.map(toMetricPoint)), range: null };
      }

      const range = parseChartRange(req.query.range) ?? DEFAULT_CHART_RANGE;
      const spec = CHART_RANGE_SPECS[range];
      const sinceMs = spec.windowMs === null ? 0 : nowMs - spec.windowMs;

      let bucketMs = spec.bucketMs;
      const firstTick = await deps.tickMetricsRepo.firstTickAt();
      if (firstTick !== null) {
        const actualSpan = nowMs - firstTick;
        const effectiveSpan =
          spec.windowMs === null ? actualSpan : Math.min(spec.windowMs, actualSpan);
        if (effectiveSpan > 0) {
          bucketMs = pickBucketForSpan(effectiveSpan);
        }
      }

      const rows = await deps.tickMetricsRepo.listAggregated(sinceMs, bucketMs, limit);
      return { points: withProfit(rows.map(toMetricPoint)), range };
    },
  );
}

function toMetricPoint(r: {
  tick_at: number;
  delivered_ph: number;
  target_ph: number;
  floor_ph: number;
  our_primary_price_sat_per_eh_day: number | null;
  best_bid_sat_per_eh_day: number | null;
  best_ask_sat_per_eh_day: number | null;
  fillable_ask_sat_per_eh_day: number | null;
  hashprice_sat_per_eh_day: number | null;
  max_bid_sat_per_eh_day: number | null;
  available_balance_sat: number | null;
  total_balance_sat: number | null;
  datum_hashrate_ph: number | null;
  ocean_hashrate_ph: number | null;
  share_log_pct: number | null;
  primary_bid_consumed_sat: number | null;
  network_difficulty: number | null;
  pool_hashrate_ph: number | null;
  estimated_block_reward_sat: number | null;
  btc_usd_price: number | null;
  ocean_unpaid_sat: number | null;
  paid_total_sat: number | null;
  pool_blocks_24h_count: number | null;
  pool_blocks_7d_count: number | null;
  pool_hashrate_ph_avg_24h: number | null;
  pool_hashrate_ph_avg_7d: number | null;
  pool_luck_24h: number | null;
  pool_luck_7d: number | null;
  pool_luck_30d: number | null;
  pool_blocks_30d_count: number | null;
  pool_hashrate_ph_avg_30d: number | null;
  braiins_reachable: number | null;
}): MetricPoint {
  return {
    tick_at: r.tick_at,
    delivered_ph: r.delivered_ph,
    target_ph: r.target_ph,
    floor_ph: r.floor_ph,
    our_primary_price_sat_per_ph_day:
      r.our_primary_price_sat_per_eh_day !== null
        ? r.our_primary_price_sat_per_eh_day / EH_PER_PH
        : null,
    best_bid_sat_per_ph_day:
      r.best_bid_sat_per_eh_day !== null ? r.best_bid_sat_per_eh_day / EH_PER_PH : null,
    best_ask_sat_per_ph_day:
      r.best_ask_sat_per_eh_day !== null ? r.best_ask_sat_per_eh_day / EH_PER_PH : null,
    fillable_ask_sat_per_ph_day:
      r.fillable_ask_sat_per_eh_day !== null
        ? r.fillable_ask_sat_per_eh_day / EH_PER_PH
        : null,
    hashprice_sat_per_ph_day:
      r.hashprice_sat_per_eh_day !== null
        ? r.hashprice_sat_per_eh_day / EH_PER_PH
        : null,
    max_bid_sat_per_ph_day:
      r.max_bid_sat_per_eh_day !== null
        ? r.max_bid_sat_per_eh_day / EH_PER_PH
        : null,
    available_balance_sat: r.available_balance_sat,
    total_balance_sat: r.total_balance_sat,
    datum_hashrate_ph: r.datum_hashrate_ph,
    ocean_hashrate_ph: r.ocean_hashrate_ph,
    share_log_pct: r.share_log_pct,
    primary_bid_consumed_sat: r.primary_bid_consumed_sat,
    network_difficulty: r.network_difficulty,
    pool_hashrate_ph: r.pool_hashrate_ph,
    estimated_block_reward_sat: r.estimated_block_reward_sat,
    btc_usd_price: r.btc_usd_price,
    ocean_unpaid_sat: r.ocean_unpaid_sat,
    paid_total_sat: r.paid_total_sat,
    pool_blocks_24h_count: r.pool_blocks_24h_count,
    pool_blocks_7d_count: r.pool_blocks_7d_count,
    pool_hashrate_ph_avg_24h: r.pool_hashrate_ph_avg_24h,
    pool_hashrate_ph_avg_7d: r.pool_hashrate_ph_avg_7d,
    pool_luck_24h: r.pool_luck_24h,
    pool_luck_7d: r.pool_luck_7d,
    pool_luck_30d: r.pool_luck_30d,
    pool_blocks_30d_count: r.pool_blocks_30d_count,
    pool_hashrate_ph_avg_30d: r.pool_hashrate_ph_avg_30d,
    braiins_reachable: r.braiins_reachable,
    // Populated in withProfit() below once the full ascending series
    // is known. toMetricPoint sees one row at a time so it can't
    // delta against the prior bucket; that's the second pass's job.
    profit_sat: null,
    revenue_sat: null,
    cost_sat: null,
  };
}

/**
 * #220: second pass over an ascending-by-tick_at series of MetricPoints,
 * populating profit_sat / revenue_sat / cost_sat from consecutive-bucket
 * deltas. See the field-level docstring on MetricPoint.profit_sat for
 * the math and the bid-swap landmine.
 *
 * Exported for tests. Returns a new array; does not mutate the input.
 * Same length and same per-row identity in everything but the three
 * profit fields.
 */
export function withProfit(points: readonly MetricPoint[]): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const cur = points[i]!;
    if (i === 0) {
      out.push(cur);
      continue;
    }
    const prev = points[i - 1]!;

    const unpaidDelta = deltaSnapshot(prev.ocean_unpaid_sat, cur.ocean_unpaid_sat);
    const paidDelta = deltaMonotonic(prev.paid_total_sat, cur.paid_total_sat);
    const costDelta = deltaMonotonic(prev.primary_bid_consumed_sat, cur.primary_bid_consumed_sat);

    // Revenue is summable across its two parts: if one component is
    // null we still drop the bucket (we can't honestly say "revenue
    // was just the paid portion" when unpaid changed by some unknown
    // amount over the bucket).
    const revenue =
      unpaidDelta !== null && paidDelta !== null
        ? unpaidDelta + paidDelta
        : null;
    const profit =
      revenue !== null && costDelta !== null ? revenue - costDelta : null;

    out.push({
      ...cur,
      profit_sat: profit,
      revenue_sat: revenue,
      cost_sat: costDelta,
    });
  }
  return out;
}

/**
 * Delta of a snapshot column (e.g. ocean_unpaid_sat). Either endpoint
 * null -> null. The delta itself can be negative (payout crystallized,
 * unpaid dropped) and that's fine - the caller pairs it with the
 * matching paid_total_sat rise to keep the sum honest.
 */
function deltaSnapshot(prev: number | null, cur: number | null): number | null {
  if (prev === null || cur === null) return null;
  return cur - prev;
}

/**
 * Delta of a monotonic-cumulative column (paid_total_sat,
 * primary_bid_consumed_sat). Either endpoint null -> null. A negative
 * delta means the counter reset (primary-bid swap on consumed; should
 * never happen on paid). Return null in that case rather than guess;
 * the gap propagates to profit_sat and the chart renders no bar for
 * the swap bucket.
 */
function deltaMonotonic(prev: number | null, cur: number | null): number | null {
  if (prev === null || cur === null) return null;
  if (cur < prev) return null;
  return cur - prev;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
