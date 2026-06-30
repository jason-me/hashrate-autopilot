/**
 * Alert event-class taxonomy (#316).
 *
 * Alerts carry a free-form `event_class` string, and the important
 * conditions arrive as open/recovery pairs by convention:
 * `<openClass>` (the IMPORTANT alert raised when a condition starts)
 * and `<openClass>_recovery` (the INFO alert when it clears, whose
 * `paired_alert_id` points back at the opener). Each pair is therefore
 * a *span* with a start (opener.created_at) and an end
 * (recovery.created_at, or open-ended while the condition persists).
 *
 * This module is the single source of truth for which classes are
 * spans, what they're called, which chart(s) their background band
 * belongs on, and which chart-color slot tints the band. Shared so the
 * daemon (span derivation) and the dashboard (band rendering, History
 * rows, color pickers) agree on the set.
 *
 * Deliberately excluded, because the charts already draw an equivalent
 * band from another source and we must not double-band:
 *   - `marketplace_empty`  -> #167 fillable-null bands on the price chart
 *   - `sustained_paused`   -> #287 BID_PAUSED -> BID_RESUMED bands
 */

export type AlertChartTarget = 'hashrate' | 'price';

export interface ConditionSpanClass {
  /** The IMPORTANT opener event_class. */
  readonly openClass: string;
  /** The INFO recovery event_class (convention: `${openClass}_recovery`). */
  readonly recoveryClass: string;
  /** Which chart(s) the background band renders on. */
  readonly charts: readonly AlertChartTarget[];
  /** chart_color_overrides slot that tints the band + onset marker. */
  readonly colorSlot: string;
  /** Stable English label; the dashboard translates by `openClass`. */
  readonly label: string;
}

/**
 * The condition spans surfaced on the timeline, in display order.
 * Hashrate-shaped conditions live on the Hashrate chart; connectivity
 * and economic ones span both so they're visible wherever you're
 * looking; the Bitaxe thermal one is hashrate-side.
 */
export const CONDITION_SPAN_CLASSES: readonly ConditionSpanClass[] = [
  {
    openClass: 'hashrate_below_floor',
    recoveryClass: 'hashrate_below_floor_recovery',
    charts: ['hashrate'],
    colorSlot: 'events.alert_below_floor',
    label: 'Below floor',
  },
  {
    openClass: 'zero_hashrate',
    recoveryClass: 'zero_hashrate_recovery',
    charts: ['hashrate'],
    colorSlot: 'events.alert_zero_hashrate',
    label: 'Zero hashrate',
  },
  {
    openClass: 'datum_unreachable',
    recoveryClass: 'datum_unreachable_recovery',
    charts: ['hashrate', 'price'],
    colorSlot: 'events.alert_datum_unreachable',
    label: 'DATUM unreachable',
  },
  {
    openClass: 'api_unreachable',
    recoveryClass: 'api_unreachable_recovery',
    charts: ['hashrate', 'price'],
    colorSlot: 'events.alert_api_unreachable',
    label: 'Marketplace API unreachable',
  },
  {
    openClass: 'wallet_runway',
    recoveryClass: 'wallet_runway_recovery',
    charts: ['price'],
    colorSlot: 'events.alert_wallet_runway',
    label: 'Low wallet runway',
  },
  {
    openClass: 'solo_overheating',
    recoveryClass: 'solo_overheating_recovery',
    charts: ['hashrate'],
    colorSlot: 'events.alert_solo_overheating',
    label: 'Bitaxe overheating',
  },
];

/** All opener classes that define a span, for quick membership tests. */
export const CONDITION_OPEN_CLASSES: readonly string[] = CONDITION_SPAN_CLASSES.map(
  (c) => c.openClass,
);

/** All recovery classes, for quick membership tests. */
export const CONDITION_RECOVERY_CLASSES: readonly string[] = CONDITION_SPAN_CLASSES.map(
  (c) => c.recoveryClass,
);

const BY_OPEN_CLASS = new Map<string, ConditionSpanClass>(
  CONDITION_SPAN_CLASSES.map((c) => [c.openClass, c]),
);

/** Lookup a span class by its opener event_class, or undefined. */
export function conditionSpanClass(openClass: string | null | undefined): ConditionSpanClass | undefined {
  if (!openClass) return undefined;
  return BY_OPEN_CLASS.get(openClass);
}

/** True if this event_class is a span opener we surface on the timeline. */
export function isConditionOpenClass(eventClass: string | null | undefined): boolean {
  return !!eventClass && BY_OPEN_CLASS.has(eventClass);
}
