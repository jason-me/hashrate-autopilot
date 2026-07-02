/**
 * #320: rewrite the canonical unit tokens the daemon bakes into
 * bid-event `reason` strings into the operator's active display
 * denomination, so the Reason column/tooltip/export reads in the same
 * units as every structured field beside it.
 *
 * The daemon (controller/decide.ts) always emits these tokens in fixed,
 * en-US canonical form:
 *   - rates:  "<n> sat/PH/day"  (via fmtPricePH; the unit is on EVERY
 *             number, e.g. "track fillable: 48,288 sat/PH/day →
 *             47,817 sat/PH/day (fillable 47,767 sat/PH/day + overpay
 *             50 sat/PH/day)")
 *   - speeds: "<a> → <b> PH/s"  (shared unit on the pair) and standalone
 *             "<n> PH/s" (e.g. "cheap mode 3 PH/s")
 *
 * Any token that doesn't parse is left untouched, so if the daemon's
 * wording changes the reason degrades to the raw string rather than
 * getting corrupted. The prose around the numbers (English audit text)
 * is never translated - only the numeric+unit tokens are converted.
 */

export interface ReasonUnitFormatters {
  /** Format a canonical sat/PH/day value in the active denomination (value + unit). */
  rate: (satPerPhDay: number) => string;
  /** Format a canonical PH/s hashrate in the active unit (value + unit). */
  hashrate: (ph: number) => string;
}

/** A parsed reason segment: verbatim text, a rate value, or a speed value. */
export type ReasonToken =
  | { kind: 'text'; text: string }
  | { kind: 'rate'; sat: number }
  | { kind: 'speed'; ph: number };

// A number the daemon renders with en-US grouping commas and an optional
// fractional part; may be negative (a delta).
const NUM = String.raw`-?\d[\d,]*(?:\.\d+)?`;
// One alternation, tried left-to-right at each position: self-contained
// rate token, then the shared-unit speed pair (before the standalone
// speed so "a → b PH/s" captures both sides), then a lone speed token.
const TOKEN_RE = new RegExp(
  `(${NUM})\\s+sat/PH/day|(${NUM})\\s+→\\s+(${NUM})\\s+PH/s|(${NUM})\\s+PH/s`,
  'g',
);

function toNum(s: string): number {
  return Number(s.replace(/,/g, ''));
}

/**
 * Split a reason string into verbatim-text / rate / speed tokens. The
 * numeric values are returned canonical (sat/PH/day, PH/s) so callers
 * format them in the active denomination - as a plain string via
 * {@link rewriteReasonUnits} or as React nodes (with the sat glyph).
 */
export function tokenizeReason(reason: string): ReasonToken[] {
  const out: ReasonToken[] = [];
  if (!reason) return out;
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(reason)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: reason.slice(last, m.index) });
    if (m[1] !== undefined) {
      out.push({ kind: 'rate', sat: toNum(m[1]) });
    } else if (m[2] !== undefined && m[3] !== undefined) {
      out.push({ kind: 'speed', ph: toNum(m[2]) });
      out.push({ kind: 'text', text: ' → ' });
      out.push({ kind: 'speed', ph: toNum(m[3]) });
    } else if (m[4] !== undefined) {
      out.push({ kind: 'speed', ph: toNum(m[4]) });
    }
    last = TOKEN_RE.lastIndex;
  }
  if (last < reason.length) out.push({ kind: 'text', text: reason.slice(last) });
  return out;
}

/** Rewrite canonical unit tokens to the active denomination as a string. */
export function rewriteReasonUnits(reason: string, fmt: ReasonUnitFormatters): string {
  return tokenizeReason(reason)
    .map((tk) =>
      tk.kind === 'text' ? tk.text : tk.kind === 'rate' ? fmt.rate(tk.sat) : fmt.hashrate(tk.ph),
    )
    .join('');
}
