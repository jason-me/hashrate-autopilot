/**
 * #322: conditionBandRenderMode - the contract between the Timeline's
 * "View on chart" jump and the chart band layer. Chart-ful classes
 * render full bands on their target chart(s); chart-less classes
 * (marketplace_empty / sustained_paused, which the fillable-null and
 * bid-pause hatches already cover visually) render a beacon-only
 * anchor on the price chart when they are the focused span - so the
 * jump from their Timeline rows lands on something.
 */
import { describe, expect, it } from 'vitest';

import { conditionBandRenderMode } from './alert-classes.js';

describe('conditionBandRenderMode', () => {
  it('chart-ful classes render bands on their target chart, focused or not', () => {
    expect(conditionBandRenderMode('hashrate_below_floor', 'hashrate', false)).toBe('band');
    expect(conditionBandRenderMode('hashrate_below_floor', 'hashrate', true)).toBe('band');
    expect(conditionBandRenderMode('datum_unreachable', 'price', false)).toBe('band');
    expect(conditionBandRenderMode('wallet_runway', 'price', false)).toBe('band');
  });

  it('chart-ful classes render nothing on charts they do not target', () => {
    // below-floor bands only the hashrate chart; focus does not
    // promote it onto the price chart.
    expect(conditionBandRenderMode('hashrate_below_floor', 'price', true)).toBe('none');
    expect(conditionBandRenderMode('wallet_runway', 'hashrate', true)).toBe('none');
  });

  it('chart-less classes get a beacon-only anchor on the price chart when focused (#322)', () => {
    expect(conditionBandRenderMode('marketplace_empty', 'price', true)).toBe('beacon-only');
    expect(conditionBandRenderMode('sustained_paused', 'price', true)).toBe('beacon-only');
  });

  it('chart-less classes render nothing when not focused, and never on the hashrate chart', () => {
    expect(conditionBandRenderMode('marketplace_empty', 'price', false)).toBe('none');
    expect(conditionBandRenderMode('sustained_paused', 'price', false)).toBe('none');
    expect(conditionBandRenderMode('marketplace_empty', 'hashrate', true)).toBe('none');
  });

  it('unknown / null classes render nothing', () => {
    expect(conditionBandRenderMode('beta_exit', 'price', true)).toBe('none');
    expect(conditionBandRenderMode(null, 'price', true)).toBe('none');
  });
});
