import { describe, expect, it } from 'vitest';

import { withProfit, type MetricPoint } from './metrics.js';

/**
 * Minimal MetricPoint factory - every field nulled by default so the
 * test body only spells out the columns the test cares about.
 */
function pt(p: Partial<MetricPoint> & { tick_at: number }): MetricPoint {
  return {
    tick_at: p.tick_at,
    delivered_ph: p.delivered_ph ?? 0,
    target_ph: p.target_ph ?? 0,
    floor_ph: p.floor_ph ?? 0,
    our_primary_price_sat_per_ph_day: null,
    best_bid_sat_per_ph_day: null,
    best_ask_sat_per_ph_day: null,
    fillable_ask_sat_per_ph_day: null,
    hashprice_sat_per_ph_day: null,
    max_bid_sat_per_ph_day: null,
    available_balance_sat: null,
    total_balance_sat: null,
    datum_hashrate_ph: null,
    ocean_hashrate_ph: null,
    share_log_pct: null,
    primary_bid_consumed_sat: p.primary_bid_consumed_sat ?? null,
    network_difficulty: null,
    pool_hashrate_ph: null,
    estimated_block_reward_sat: null,
    btc_usd_price: null,
    ocean_unpaid_sat: p.ocean_unpaid_sat ?? null,
    paid_total_sat: p.paid_total_sat ?? null,
    pool_blocks_24h_count: null,
    pool_blocks_7d_count: null,
    pool_hashrate_ph_avg_24h: null,
    pool_hashrate_ph_avg_7d: null,
    pool_luck_24h: null,
    pool_luck_7d: null,
    pool_luck_30d: null,
    pool_blocks_30d_count: null,
    pool_hashrate_ph_avg_30d: null,
    braiins_reachable: null,
    profit_sat: null,
    revenue_sat: null,
    cost_sat: null,
  };
}

describe('withProfit', () => {
  it('first bucket has all three profit fields null (no prior to delta against)', () => {
    const out = withProfit([
      pt({ tick_at: 1, ocean_unpaid_sat: 100, paid_total_sat: 0, primary_bid_consumed_sat: 50 }),
    ]);
    expect(out[0]!.profit_sat).toBeNull();
    expect(out[0]!.revenue_sat).toBeNull();
    expect(out[0]!.cost_sat).toBeNull();
  });

  it('profit = (Δunpaid + Δpaid) - Δcost for the simple case', () => {
    // Bucket 1: unpaid 100, paid 0, cost 50
    // Bucket 2: unpaid 130, paid 0, cost 60 -> revenue 30, cost 10, profit 20
    const out = withProfit([
      pt({ tick_at: 1, ocean_unpaid_sat: 100, paid_total_sat: 0, primary_bid_consumed_sat: 50 }),
      pt({ tick_at: 2, ocean_unpaid_sat: 130, paid_total_sat: 0, primary_bid_consumed_sat: 60 }),
    ]);
    expect(out[1]!.revenue_sat).toBe(30);
    expect(out[1]!.cost_sat).toBe(10);
    expect(out[1]!.profit_sat).toBe(20);
  });

  it('payout crystallization mid-bucket nets out: unpaid drops, paid rises by the same amount', () => {
    // Bucket 1: unpaid 100, paid 0
    // Bucket 2: payout of 100 + 20 new work -> unpaid 20, paid 100
    //   Δunpaid = -80, Δpaid = +100, revenue = +20 (the new work)
    const out = withProfit([
      pt({ tick_at: 1, ocean_unpaid_sat: 100, paid_total_sat: 0, primary_bid_consumed_sat: 50 }),
      pt({ tick_at: 2, ocean_unpaid_sat: 20, paid_total_sat: 100, primary_bid_consumed_sat: 60 }),
    ]);
    expect(out[1]!.revenue_sat).toBe(20);
    expect(out[1]!.cost_sat).toBe(10);
    expect(out[1]!.profit_sat).toBe(10);
  });

  it('primary-bid swap (negative cost delta) -> profit null for the swap bucket', () => {
    // Bucket 1: consumed 500 (bid A near end of life)
    // Bucket 2: consumed 50 (bid A cancelled, bid B started fresh in same bucket)
    // We can't honestly say what was spent across the swap -> null cost -> null profit
    const out = withProfit([
      pt({ tick_at: 1, ocean_unpaid_sat: 100, paid_total_sat: 0, primary_bid_consumed_sat: 500 }),
      pt({ tick_at: 2, ocean_unpaid_sat: 110, paid_total_sat: 0, primary_bid_consumed_sat: 50 }),
    ]);
    expect(out[1]!.cost_sat).toBeNull();
    expect(out[1]!.profit_sat).toBeNull();
    // Revenue is still computable - unpaid and paid were both observed
    // at both endpoints.
    expect(out[1]!.revenue_sat).toBe(10);
  });

  it('null unpaid at either endpoint -> revenue null -> profit null', () => {
    const out = withProfit([
      pt({ tick_at: 1, ocean_unpaid_sat: null, paid_total_sat: 0, primary_bid_consumed_sat: 50 }),
      pt({ tick_at: 2, ocean_unpaid_sat: 100, paid_total_sat: 0, primary_bid_consumed_sat: 60 }),
    ]);
    expect(out[1]!.revenue_sat).toBeNull();
    expect(out[1]!.profit_sat).toBeNull();
    // Cost is still computable when both consumed values are present.
    expect(out[1]!.cost_sat).toBe(10);
  });

  it('null paid at either endpoint -> revenue null (we cannot net the unpaid drop)', () => {
    // The acceptance criterion: if we don't know paid_total at one end
    // of the bucket, we cannot tell whether a unpaid drop was a payout
    // (cancels out) or a real loss. Drop the whole revenue.
    const out = withProfit([
      pt({ tick_at: 1, ocean_unpaid_sat: 100, paid_total_sat: null, primary_bid_consumed_sat: 50 }),
      pt({ tick_at: 2, ocean_unpaid_sat: 20, paid_total_sat: 100, primary_bid_consumed_sat: 60 }),
    ]);
    expect(out[1]!.revenue_sat).toBeNull();
    expect(out[1]!.profit_sat).toBeNull();
  });

  it('pre-migration buckets (all-null inputs) propagate to all-null profit', () => {
    const out = withProfit([
      pt({ tick_at: 1 }),
      pt({ tick_at: 2 }),
      pt({ tick_at: 3, ocean_unpaid_sat: 100, paid_total_sat: 0, primary_bid_consumed_sat: 50 }),
      pt({ tick_at: 4, ocean_unpaid_sat: 120, paid_total_sat: 0, primary_bid_consumed_sat: 60 }),
    ]);
    expect(out[0]!.profit_sat).toBeNull();
    expect(out[1]!.profit_sat).toBeNull();
    expect(out[2]!.profit_sat).toBeNull();
    expect(out[3]!.profit_sat).toBe(10);
  });

  it('flat bucket (no change in any input) -> zero profit, not null', () => {
    const out = withProfit([
      pt({ tick_at: 1, ocean_unpaid_sat: 100, paid_total_sat: 0, primary_bid_consumed_sat: 50 }),
      pt({ tick_at: 2, ocean_unpaid_sat: 100, paid_total_sat: 0, primary_bid_consumed_sat: 50 }),
    ]);
    expect(out[1]!.revenue_sat).toBe(0);
    expect(out[1]!.cost_sat).toBe(0);
    expect(out[1]!.profit_sat).toBe(0);
  });

  it('returns a new array, does not mutate the input rows', () => {
    const input: MetricPoint[] = [
      pt({ tick_at: 1, ocean_unpaid_sat: 100, paid_total_sat: 0, primary_bid_consumed_sat: 50 }),
      pt({ tick_at: 2, ocean_unpaid_sat: 130, paid_total_sat: 0, primary_bid_consumed_sat: 60 }),
    ];
    const out = withProfit(input);
    expect(out).not.toBe(input);
    expect(input[1]!.profit_sat).toBeNull(); // input untouched
    expect(out[1]!.profit_sat).toBe(20);
  });
});
