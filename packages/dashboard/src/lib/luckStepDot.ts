/**
 * Pool-luck step marker dot positioning.
 *
 * Extracted from HashrateChart.tsx's `visibleLuckStepMarkers` so the
 * directional invariant the operator's flagged at least four times
 * can be locked in by tests:
 *
 *   FOUND  ('in' only)  ⇒ dot at the highest the line reaches in window
 *   AGED   ('out' only) ⇒ dot at the lowest  the line reaches in window
 *   mixed              ⇒ first value differing from luckBefore
 *
 * Returns the *offset within the window* of the chosen tick (so the
 * caller can resolve back to a `points[afterIdx + offset]`) and the
 * luck value to place the dot at. Null when no usable luck samples
 * exist in the window AND there's no luckBefore fallback (genuinely
 * uncharted territory; caller should skip the marker).
 *
 * Why a window rather than the full data: callers cap the window at
 * the next event group's afterIdx so a later block's step never gets
 * misattributed to this one. Inside that bound, the scan picks the
 * directional extremum so it doesn't fall apart when Ocean's snapshot
 * lag stretches past the previous arbitrary 15-tick fence.
 */
export type LuckEventKind = 'in' | 'out';

export interface PickLuckDotResult {
  /** Offset within the window (0-indexed). 0 means afterIdx itself. */
  readonly offset: number;
  /** Luck value to place the dot at. */
  readonly luck: number;
}

export function pickLuckStepDot(
  events: ReadonlyArray<{ kind: LuckEventKind }>,
  luckBefore: number | null,
  windowValues: ReadonlyArray<number | null>,
): PickLuckDotResult | null {
  const hasIn = events.some((e) => e.kind === 'in');
  const hasOut = events.some((e) => e.kind === 'out');

  // Walk the window once. Track both the directional extremum and
  // the first non-null value (the fallback for mixed groups and for
  // groups where the extremum equals luckBefore).
  let extremumIdx = 0;
  let extremumVal: number | null = null;
  let firstSeenIdx = 0;
  let firstSeenVal: number | null = null;

  for (let i = 0; i < windowValues.length; i += 1) {
    const v = windowValues[i];
    if (v === null || v === undefined) continue;
    if (firstSeenVal === null) {
      firstSeenVal = v;
      firstSeenIdx = i;
    }
    if (hasIn && !hasOut) {
      if (extremumVal === null || v > extremumVal) {
        extremumVal = v;
        extremumIdx = i;
      }
    } else if (hasOut && !hasIn) {
      if (extremumVal === null || v < extremumVal) {
        extremumVal = v;
        extremumIdx = i;
      }
    } else {
      // Mixed kinds in the same tick group - direction is ambiguous.
      // Legacy semantic: first value that differs from luckBefore. If
      // luckBefore is null, take the first non-null tick.
      if (luckBefore === null && extremumVal === null) {
        extremumVal = v;
        extremumIdx = i;
        break;
      }
      if (luckBefore !== null && v !== luckBefore) {
        extremumVal = v;
        extremumIdx = i;
        break;
      }
    }
  }

  if (extremumVal !== null) {
    // Directional clamp: a FOUND dot must never sit BELOW the
    // pre-step line, an AGED OUT dot never ABOVE. Covers the
    // pathological case where Ocean's snapshot moves briefly against
    // the per-event direction (e.g., a co-occurring AGED OUT cancels
    // a FOUND's contribution and then some).
    if (luckBefore !== null && hasIn && !hasOut && extremumVal < luckBefore) {
      return { offset: 0, luck: luckBefore };
    }
    if (luckBefore !== null && hasOut && !hasIn && extremumVal > luckBefore) {
      return { offset: 0, luck: luckBefore };
    }
    return { offset: extremumIdx, luck: extremumVal };
  }

  if (firstSeenVal !== null) {
    return { offset: firstSeenIdx, luck: firstSeenVal };
  }

  if (luckBefore !== null) {
    return { offset: 0, luck: luckBefore };
  }

  return null;
}
