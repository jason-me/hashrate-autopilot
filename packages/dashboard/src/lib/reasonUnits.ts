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

// A number the daemon renders with en-US grouping commas and an optional
// fractional part; may be negative (a delta).
const NUM = String.raw`-?\d[\d,]*(?:\.\d+)?`;
const RATE_RE = new RegExp(`(${NUM})\\s+sat/PH/day`, 'g');
const SPEED_PAIR_RE = new RegExp(`(${NUM})\\s+→\\s+(${NUM})\\s+PH/s`, 'g');
const SPEED_ONE_RE = new RegExp(`(${NUM})\\s+PH/s`, 'g');

function toNum(s: string): number {
  return Number(s.replace(/,/g, ''));
}

export function rewriteReasonUnits(reason: string, fmt: ReasonUnitFormatters): string {
  if (!reason) return reason;
  // Rates first: each token is self-contained (unit on every number).
  let out = reason.replace(RATE_RE, (m, num: string) => {
    const n = toNum(num);
    return Number.isFinite(n) ? fmt.rate(n) : m;
  });
  // Speed pairs "<a> → <b> PH/s" carry one shared unit, so convert both
  // sides in one go before the standalone pass (which would otherwise
  // only reach the trailing number).
  out = out.replace(SPEED_PAIR_RE, (m, a: string, b: string) => {
    const na = toNum(a);
    const nb = toNum(b);
    return Number.isFinite(na) && Number.isFinite(nb)
      ? `${fmt.hashrate(na)} → ${fmt.hashrate(nb)}`
      : m;
  });
  out = out.replace(SPEED_ONE_RE, (m, num: string) => {
    const n = toNum(num);
    return Number.isFinite(n) ? fmt.hashrate(n) : m;
  });
  return out;
}
