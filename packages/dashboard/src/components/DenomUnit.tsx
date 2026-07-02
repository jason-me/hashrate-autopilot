/**
 * #320: render denomination units with the Satoshi glyph instead of the
 * word "sat" (shorter + nicer), for the Timeline column headers, the
 * Δ-price filter label, and bid-event reason text.
 *
 * The sat glyph is a Font Awesome element (see SatSymbol), so it can only
 * live in JSX - these helpers are the JSX counterpart to the plain-string
 * formatters on the denomination context (which stay in use for the Excel
 * export, where a font glyph can't render).
 */

import { Fragment } from 'react';

import type { DenominationContextValue } from '../lib/denomination';
import { tokenizeReason } from '../lib/reasonUnits';
import { SatSymbol } from './SatSymbol';

/**
 * A rate suffix (e.g. "sat/PH/day", "₿/EH/day", "$/PH/day") with a
 * leading "sat" swapped for the Satoshi glyph. Any other currency prefix
 * (₿, $) is already a short symbol and renders as-is.
 */
export function RateSuffix({ suffix }: { suffix: string }) {
  if (suffix.startsWith('sat')) {
    return (
      <>
        <SatSymbol />
        {suffix.slice(3)}
      </>
    );
  }
  return <>{suffix}</>;
}

/**
 * A bid-event reason with its canonical sat/PH/day + PH/s tokens rendered
 * in the active denomination (sat values carry the Satoshi glyph). Text
 * between tokens is verbatim (the daemon's English audit wording).
 */
export function ReasonText({
  reason,
  denomination,
}: {
  reason: string;
  denomination: DenominationContextValue;
}) {
  const tokens = tokenizeReason(reason);
  return (
    <>
      {tokens.map((tk, i) => {
        if (tk.kind === 'text') return <Fragment key={i}>{tk.text}</Fragment>;
        if (tk.kind === 'speed') return <Fragment key={i}>{denomination.formatHashrate(tk.ph)}</Fragment>;
        return (
          <Fragment key={i}>
            {denomination.formatSatPerPhDayValue(tk.sat)} <RateSuffix suffix={denomination.rateSuffix} />
          </Fragment>
        );
      })}
    </>
  );
}
