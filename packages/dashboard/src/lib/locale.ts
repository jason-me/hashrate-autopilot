/**
 * Format-preference pickers - govern only how *numbers* and *dates*
 * look on screen (thousand separators, date layout, time format).
 * NOT the UI language: that lives in `lib/i18n.ts` and is driven by
 * the Lingui-backed LanguagePicker dropdown in the header.
 *
 * #147 split a single conflated "number & date format" dropdown into
 * two independent controls:
 *
 *   - `numberLocale` (Intl locale string) — drives `Intl.NumberFormat`
 *     (thousand / decimal separators only). Persisted to localStorage
 *     as `braiins.numberLocale`.
 *   - `dateLayout` (discrete enum) — drives date/time *layout* (order,
 *     separators, 12h vs 24h). Persisted to localStorage as
 *     `braiins.dateLayout`. Month-name *language* is always whichever
 *     UI language the operator has picked (via `useDateTimeLocale`).
 *
 * One-time migration from the legacy single `braiins.displayLocale`
 * key happens in `useLocaleState`. After migration runs, the old key
 * is removed from localStorage.
 */

import { useLingui } from '@lingui/react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import {
  formatAge as formatAgeRaw,
  formatHashratePH as formatHashratePHRaw,
  formatNumber as formatNumberRaw,
  formatSatPerPH as formatSatPerPHRaw,
  formatSats as formatSatsRaw,
  formatTimestamp as formatTimestampRaw,
  type DateLayout,
} from './format';

const NUMBER_LOCALE_KEY = 'braiins.numberLocale';
const DATE_LAYOUT_KEY = 'braiins.dateLayout';
const LEGACY_DISPLAY_LOCALE_KEY = 'braiins.displayLocale';

export type { DateLayout } from './format';

/**
 * Number-format presets. The dropdown shows only the separators it
 * controls (not a date sample) - that's the date layout's job now.
 */
export const NUMBER_LOCALE_PRESETS: ReadonlyArray<{ code: string; sample: string }> = [
  { code: 'system', sample: '' },
  { code: 'en-US', sample: '1,234.56' },
  { code: 'nl-NL', sample: '1.234,56' },
  { code: 'fr-FR', sample: '1 234,56' },
  { code: 'no-grouping', sample: '1234.56' },
];

/**
 * Date-layout presets. The sample is built dynamically at render
 * time from the operator's UI language (see `formatTimestampSample`
 * in lib/format.ts) so the picker reflects exactly what the live
 * dashboard will render.
 */
export const DATE_LAYOUT_PRESETS: ReadonlyArray<DateLayout> = [
  'system',
  'us',
  'eu-spaced-24h',
  'slash-dmy-24h',
  'iso',
  'slash-mdy-12h',
];

function isDateLayout(v: string | null | undefined): v is DateLayout {
  if (!v) return false;
  return (DATE_LAYOUT_PRESETS as readonly string[]).includes(v);
}

function isKnownNumberLocale(v: string | null | undefined): boolean {
  if (!v) return false;
  return NUMBER_LOCALE_PRESETS.some((p) => p.code === v);
}

/**
 * Migrate the legacy single `braiins.displayLocale` key into the
 * new pair if and only if the new keys are unset. Runs once per
 * `useLocaleState` mount; safe to call repeatedly (no-op when new
 * keys already exist).
 *
 *   en-US -> numberLocale=en-US, dateLayout=us
 *   en-GB -> numberLocale=en-US, dateLayout=eu-spaced-24h
 *   nl-NL / de-DE / es-ES / pt-BR -> numberLocale=nl-NL, dateLayout=eu-spaced-24h
 *   fr-FR -> numberLocale=fr-FR, dateLayout=eu-spaced-24h
 *   auto / unknown / unset -> numberLocale=system, dateLayout=system
 */
function migrateLegacyDisplayLocale(): void {
  if (typeof window === 'undefined') return;
  const ls = window.localStorage;
  const hasNew = ls.getItem(NUMBER_LOCALE_KEY) !== null || ls.getItem(DATE_LAYOUT_KEY) !== null;
  const legacy = ls.getItem(LEGACY_DISPLAY_LOCALE_KEY);
  if (hasNew || legacy === null) return;

  let numberLocale: string = 'system';
  let dateLayout: DateLayout = 'system';
  switch (legacy) {
    case 'en-US':
      numberLocale = 'en-US';
      dateLayout = 'us';
      break;
    case 'en-GB':
      numberLocale = 'en-US';
      dateLayout = 'eu-spaced-24h';
      break;
    case 'nl-NL':
    case 'de-DE':
    case 'es-ES':
    case 'pt-BR':
      numberLocale = 'nl-NL';
      dateLayout = 'eu-spaced-24h';
      break;
    case 'fr-FR':
      numberLocale = 'fr-FR';
      dateLayout = 'eu-spaced-24h';
      break;
    default:
      // 'auto' or unknown -> system / system
      break;
  }
  ls.setItem(NUMBER_LOCALE_KEY, numberLocale);
  ls.setItem(DATE_LAYOUT_KEY, dateLayout);
  ls.removeItem(LEGACY_DISPLAY_LOCALE_KEY);
}

export function getStoredNumberLocale(): string {
  if (typeof window === 'undefined') return 'system';
  const v = window.localStorage.getItem(NUMBER_LOCALE_KEY);
  return v ?? 'system';
}

export function getStoredDateLayout(): DateLayout {
  if (typeof window === 'undefined') return 'system';
  const v = window.localStorage.getItem(DATE_LAYOUT_KEY);
  return isDateLayout(v) ? v : 'system';
}

/**
 * Resolves the chosen numberLocale to an Intl-locale string (or
 * undefined for "browser default"). `no-grouping` is a sentinel:
 * the numberLocale itself stays en-US but callers know to disable
 * thousands grouping; we expose that via `useFormatters`.
 */
export function resolveNumberLocale(selected: string): string | undefined {
  if (selected === 'system') return undefined;
  if (selected === 'no-grouping') return 'en-US';
  if (isKnownNumberLocale(selected)) return selected;
  return undefined;
}

export interface LocaleContextValue {
  /** Raw numberLocale preset code as stored (e.g. `system`, `en-US`, `no-grouping`). */
  numberLocale: string;
  /** Date-layout enum value. */
  dateLayout: DateLayout;
  /** Resolved Intl-locale string for number formatting (undefined = browser default). */
  intlLocale: string | undefined;
  /** True when the operator picked the "no thousands grouping" preset. */
  numberGrouping: boolean;
  setNumberLocale: (code: string) => void;
  setDateLayout: (layout: DateLayout) => void;
}

export const LocaleContext = createContext<LocaleContextValue>({
  numberLocale: 'system',
  dateLayout: 'system',
  intlLocale: undefined,
  numberGrouping: true,
  setNumberLocale: () => undefined,
  setDateLayout: () => undefined,
});

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

export function useLocaleState(): LocaleContextValue {
  // One-shot migration before initial state read so the first paint
  // already reflects the migrated values.
  const [numberLocale, setNumberLocaleState] = useState(() => {
    migrateLegacyDisplayLocale();
    return getStoredNumberLocale();
  });
  const [dateLayout, setDateLayoutState] = useState<DateLayout>(() => getStoredDateLayout());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(NUMBER_LOCALE_KEY, numberLocale);
  }, [numberLocale]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(DATE_LAYOUT_KEY, dateLayout);
  }, [dateLayout]);

  return {
    numberLocale,
    dateLayout,
    intlLocale: resolveNumberLocale(numberLocale),
    numberGrouping: numberLocale !== 'no-grouping',
    setNumberLocale: setNumberLocaleState,
    setDateLayout: setDateLayoutState,
  };
}

/**
 * BCP-47 locale to use for *date and time* formatting. Derived from
 * the UI-language setting (Lingui), NOT from the format-preference
 * dropdowns. Without this, picking a Dutch number/date format
 * preference would also switch chart x-axis day-name abbreviations
 * and runway/next-payout month names to Dutch even when the
 * operator has the UI in English. The two settings are supposed to
 * be independent; this hook is the seam.
 *
 * Mapping:
 *   en -> en-US   (Mon / Apr / etc)
 *   nl -> nl-NL   (ma / apr / etc)
 *   es -> es-ES   (lun / abr / etc)
 *
 * The *layout* (DMY vs MDY, 12h vs 24h, separators) is controlled
 * separately by the dateLayout enum.
 */
export function useDateTimeLocale(): string {
  const { i18n } = useLingui();
  switch (i18n.locale) {
    case 'nl':
      return 'nl-NL';
    case 'es':
      return 'es-ES';
    case 'en':
    default:
      return 'en-US';
  }
}

/**
 * Pre-bound formatters that use the current display locale. Components
 * call these like `fmt.satPerPH(n)` instead of `formatSatPerPH(n, locale)`.
 *
 * The timestamp formatter binds both the UI-language locale (for
 * month-name language) and the dateLayout enum, so call sites get
 * the right combination without having to remember to thread both.
 */
export function useFormatters() {
  const { intlLocale, dateLayout, numberGrouping } = useLocale();
  const dateTimeLocale = useDateTimeLocale();
  return useMemo(
    () => ({
      number: (n: number, opts?: Intl.NumberFormatOptions) =>
        formatNumberRaw(
          n,
          numberGrouping ? opts : { useGrouping: false, ...opts },
          intlLocale,
        ),
      satPerPH: (n: number | null | undefined) => formatSatPerPHRaw(n, intlLocale),
      sats: (n: number | null | undefined) => formatSatsRaw(n, intlLocale),
      hashratePH: (n: number | null | undefined) => formatHashratePHRaw(n, intlLocale),
      timestamp: (ms: number | null | undefined) =>
        formatTimestampRaw(ms, { uiLocale: dateTimeLocale, layout: dateLayout }),
      age: formatAgeRaw,
    }),
    [intlLocale, dateLayout, numberGrouping, dateTimeLocale],
  );
}
