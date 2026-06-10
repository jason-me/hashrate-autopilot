import { describe, expect, it } from 'vitest';

import { pickLuckStepDot } from './luckStepDot';

describe('pickLuckStepDot - FOUND (in)', () => {
  it('lands on the post-step value when Ocean updates immediately', () => {
    const r = pickLuckStepDot(
      [{ kind: 'in' }],
      1.5,
      [2.1, 2.1, 2.1, 2.1], // Ocean updates at offset 0
    );
    expect(r).toEqual({ offset: 0, luck: 2.1 });
  });

  it('lands on the post-step value when Ocean lags past the legacy 15-tick fence', () => {
    // 20 ticks of pre-step before the new value lands - the previous
    // implementation would have given up at tick 15 and stuck the dot
    // on the pre-step segment.
    const window: (number | null)[] = Array(20).fill(1.5);
    window.push(2.1, 2.1, 2.1);
    const r = pickLuckStepDot([{ kind: 'in' }], 1.5, window);
    expect(r).toEqual({ offset: 20, luck: 2.1 });
  });

  it('lands on the post-step value when Ocean updates with intermediate noise', () => {
    // Multiple stepped values in window - pick the max.
    const r = pickLuckStepDot(
      [{ kind: 'in' }],
      1.5,
      [1.5, 1.5, 1.6, 1.8, 2.1, 2.0, 1.9],
    );
    expect(r).toEqual({ offset: 4, luck: 2.1 });
  });

  it('falls back to luckBefore when Ocean never updates in window', () => {
    const r = pickLuckStepDot(
      [{ kind: 'in' }],
      1.5,
      [1.5, 1.5, 1.5, 1.5],
    );
    expect(r).toEqual({ offset: 0, luck: 1.5 });
  });

  it('clamps to luckBefore when the data moves AGAINST the FOUND direction', () => {
    // Pathological: a FOUND event whose window shows luck DECREASING
    // (e.g. an AGED OUT in the same Ocean snapshot more than cancels
    // the FOUND's contribution). Strict invariant: FOUND dot never
    // below the pre-step line.
    const r = pickLuckStepDot(
      [{ kind: 'in' }],
      1.5,
      [1.5, 1.3, 1.2, 1.1],
    );
    expect(r).toEqual({ offset: 0, luck: 1.5 });
  });

  it('handles null-laced windows (Ocean skipped some snapshots)', () => {
    const r = pickLuckStepDot(
      [{ kind: 'in' }],
      1.5,
      [null, null, 1.5, null, 2.1, null, 2.0],
    );
    expect(r).toEqual({ offset: 4, luck: 2.1 });
  });

  it('uses first seen value when luckBefore is null (event at start of data)', () => {
    const r = pickLuckStepDot(
      [{ kind: 'in' }],
      null,
      [null, 1.5, 2.1, 2.0],
    );
    // No luckBefore to clamp against; the directional extremum (max)
    // applies but the clamp doesn't.
    expect(r).toEqual({ offset: 2, luck: 2.1 });
  });
});

describe('pickLuckStepDot - AGED OUT (out)', () => {
  it('lands on the post-step value when Ocean updates immediately', () => {
    const r = pickLuckStepDot(
      [{ kind: 'out' }],
      2.1,
      [1.5, 1.5, 1.5, 1.5],
    );
    expect(r).toEqual({ offset: 0, luck: 1.5 });
  });

  it('lands on the post-step value when Ocean lags past the legacy 15-tick fence', () => {
    const window: (number | null)[] = Array(20).fill(2.1);
    window.push(1.5, 1.5, 1.5);
    const r = pickLuckStepDot([{ kind: 'out' }], 2.1, window);
    expect(r).toEqual({ offset: 20, luck: 1.5 });
  });

  it('picks the minimum in window for noisy data', () => {
    const r = pickLuckStepDot(
      [{ kind: 'out' }],
      2.1,
      [2.1, 2.1, 1.9, 1.7, 1.5, 1.6, 1.7],
    );
    expect(r).toEqual({ offset: 4, luck: 1.5 });
  });

  it('falls back to luckBefore when Ocean never updates in window', () => {
    const r = pickLuckStepDot(
      [{ kind: 'out' }],
      2.1,
      [2.1, 2.1, 2.1, 2.1],
    );
    expect(r).toEqual({ offset: 0, luck: 2.1 });
  });

  it('clamps to luckBefore when the data moves AGAINST the AGED direction', () => {
    const r = pickLuckStepDot(
      [{ kind: 'out' }],
      2.1,
      [2.1, 2.2, 2.3, 2.4],
    );
    expect(r).toEqual({ offset: 0, luck: 2.1 });
  });
});

describe('pickLuckStepDot - mixed (in+out at same tick)', () => {
  it('picks first value differing from luckBefore (legacy semantic)', () => {
    const r = pickLuckStepDot(
      [{ kind: 'in' }, { kind: 'out' }],
      1.5,
      [1.5, 1.5, 1.7, 1.7],
    );
    expect(r).toEqual({ offset: 2, luck: 1.7 });
  });

  it('falls back to luckBefore when no change in window', () => {
    const r = pickLuckStepDot(
      [{ kind: 'in' }, { kind: 'out' }],
      1.5,
      [1.5, 1.5, 1.5, 1.5],
    );
    expect(r).toEqual({ offset: 0, luck: 1.5 });
  });
});

describe('pickLuckStepDot - edge cases', () => {
  it('returns null when window is empty AND luckBefore is null', () => {
    const r = pickLuckStepDot([{ kind: 'in' }], null, []);
    expect(r).toBeNull();
  });

  it('returns luckBefore when window is empty but luckBefore is known', () => {
    const r = pickLuckStepDot([{ kind: 'in' }], 1.5, []);
    expect(r).toEqual({ offset: 0, luck: 1.5 });
  });

  it('returns null when window is all nulls AND luckBefore is null', () => {
    const r = pickLuckStepDot([{ kind: 'in' }], null, [null, null, null]);
    expect(r).toBeNull();
  });
});
