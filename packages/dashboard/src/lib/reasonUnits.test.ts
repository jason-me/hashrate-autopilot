import { describe, expect, it } from 'vitest';

import { rewriteReasonUnits, type ReasonUnitFormatters } from './reasonUnits';

// Sentinel formatters so assertions can see exactly which numbers were
// parsed and routed to which converter, independent of locale/rounding.
const fmt: ReasonUnitFormatters = {
  rate: (n) => `[R:${n}]`,
  hashrate: (n) => `[H:${n}]`,
};

describe('rewriteReasonUnits', () => {
  it('converts every self-contained rate token (the real track-fillable reason)', () => {
    const reason =
      'track fillable: 48,288 sat/PH/day → 47,817 sat/PH/day (fillable 47,767 sat/PH/day + overpay 50 sat/PH/day)';
    expect(rewriteReasonUnits(reason, fmt)).toBe(
      'track fillable: [R:48288] → [R:47817] (fillable [R:47767] + overpay [R:50])',
    );
  });

  it('converts both sides of a shared-unit speed pair', () => {
    expect(rewriteReasonUnits('target_hashrate change: speed 3 → 5 PH/s (cheap mode)', fmt)).toBe(
      'target_hashrate change: speed [H:3] → [H:5] (cheap mode)',
    );
  });

  it('converts a standalone speed token', () => {
    expect(rewriteReasonUnits('create at 48,000 sat/PH/day · cheap mode 3 PH/s', fmt)).toBe(
      'create at [R:48000] · cheap mode [H:3]',
    );
  });

  it('handles fractional and negative numbers', () => {
    expect(rewriteReasonUnits('delta -471 sat/PH/day', fmt)).toBe('delta [R:-471]');
    expect(rewriteReasonUnits('speed 2.5 PH/s', fmt)).toBe('speed [H:2.5]');
  });

  it('leaves reasons without unit tokens untouched', () => {
    const reason = 'Multiple owned bids; keeping primary only';
    expect(rewriteReasonUnits(reason, fmt)).toBe(reason);
  });

  it('is a no-op on empty input', () => {
    expect(rewriteReasonUnits('', fmt)).toBe('');
  });
});
