/**
 * GET /api/bid-events?range=<preset>
 *
 * Returns executed CREATE/EDIT/CANCEL bid events inside the given range's
 * visible window, in chronological order. Used by the dashboard chart to
 * overlay markers on the price series.
 *
 * For ranges ≥ 1 month the overlay is suppressed at the product level
 * (individual markers lose signal at that zoom), so the server simply
 * returns an empty list. The dashboard does not need a separate
 * "hide events" switch.
 *
 * Prices are returned in sat/PH/day (internal storage is sat/EH/day;
 * divide by 1000 on serialisation, same convention as /api/metrics).
 *
 * Legacy: `since=<ms>` is still accepted.
 */

import type { FastifyInstance } from 'fastify';

import {
  CHART_RANGE_SPECS,
  DEFAULT_CHART_RANGE,
  parseChartRange,
  showEventKindsForSpan,
} from '@hashrate-autopilot/shared';

import type { HttpServerDeps } from '../server.js';

const EH_PER_PH = 1000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface BidEventView {
  readonly id: number;
  readonly occurred_at: number;
  readonly source: 'AUTOPILOT' | 'OPERATOR';
  readonly kind: 'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID';
  readonly braiins_order_id: string | null;
  readonly old_price_sat_per_ph_day: number | null;
  readonly new_price_sat_per_ph_day: number | null;
  readonly speed_limit_ph: number | null;
  readonly amount_sat: number | null;
  readonly reason: string | null;
  /** #120: snapshot of the overpay setting at event time. Null on legacy rows. */
  readonly overpay_sat_per_ph_day: number | null;
  /** #120: snapshot of the dynamic-cap ceiling at event time. Null on legacy rows. */
  readonly max_overpay_vs_hashprice_sat_per_ph_day: number | null;
}

export async function registerBidEventsRoute(
  app: FastifyInstance,
  deps: HttpServerDeps,
): Promise<void> {
  app.get<{ Querystring: { range?: string; since?: string; until?: string } }>(
    '/api/bid-events',
    async (req) => {
      const parsedSince = Number.parseInt(req.query.since ?? '', 10);
      const parsedUntil = Number.parseInt(req.query.until ?? '', 10);

      // #169: arbitrary viewport path: since=<ms>&until=<ms>
      if (
        !req.query.range &&
        Number.isFinite(parsedSince) && parsedSince > 0 &&
        Number.isFinite(parsedUntil) && parsedUntil > parsedSince
      ) {
        const kinds = showEventKindsForSpan(parsedUntil - parsedSince);
        if (kinds.length === 0) return { events: [] };
        const allowedKinds = new Set(kinds);
        const rows = await deps.bidEventsRepo.listSince(parsedSince, parsedUntil);
        return { events: rows.filter((r) => allowedKinds.has(r.kind)).map(toView) };
      }

      // Legacy: ?since=<ms> alone forces the classic raw lookup.
      if (!req.query.range && Number.isFinite(parsedSince) && parsedSince > 0) {
        const rows = await deps.bidEventsRepo.listSince(parsedSince);
        return { events: rows.map(toView) };
      }

      const range = parseChartRange(req.query.range) ?? DEFAULT_CHART_RANGE;
      const spec = CHART_RANGE_SPECS[range];

      if (spec.showEventKinds.length === 0) {
        return { events: [] };
      }

      const allowedKinds = new Set(spec.showEventKinds);
      const sinceMs =
        spec.windowMs === null
          ? 0
          : Date.now() - spec.windowMs;
      const rows = (
        await deps.bidEventsRepo.listSince(
          sinceMs === 0 ? 0 : Math.max(0, sinceMs),
        )
      ).filter((r) => allowedKinds.has(r.kind));

      // Legacy default window (24 h) if someone calls /api/bid-events
      // with no params at all - unchanged behaviour.
      if (!req.query.range && !Number.isFinite(parsedSince)) {
        const defaultSince = Date.now() - DEFAULT_WINDOW_MS;
        const filtered = rows.filter((r) => r.occurred_at >= defaultSince);
        return { events: filtered.map(toView) };
      }

      return { events: rows.map(toView) };
    },
  );
}

function toView(r: {
  id: number;
  occurred_at: number;
  source: 'AUTOPILOT' | 'OPERATOR';
  kind: 'CREATE_BID' | 'EDIT_PRICE' | 'EDIT_SPEED' | 'CANCEL_BID';
  braiins_order_id: string | null;
  old_price_sat: number | null;
  new_price_sat: number | null;
  speed_limit_ph: number | null;
  amount_sat: number | null;
  reason: string | null;
  overpay_sat_per_eh_day: number | null;
  max_overpay_vs_hashprice_sat_per_eh_day: number | null;
}): BidEventView {
  return {
    id: r.id,
    occurred_at: r.occurred_at,
    source: r.source,
    kind: r.kind,
    braiins_order_id: r.braiins_order_id,
    old_price_sat_per_ph_day:
      r.old_price_sat !== null ? r.old_price_sat / EH_PER_PH : null,
    new_price_sat_per_ph_day:
      r.new_price_sat !== null ? r.new_price_sat / EH_PER_PH : null,
    speed_limit_ph: r.speed_limit_ph,
    amount_sat: r.amount_sat,
    reason: r.reason,
    overpay_sat_per_ph_day:
      r.overpay_sat_per_eh_day !== null ? r.overpay_sat_per_eh_day / EH_PER_PH : null,
    max_overpay_vs_hashprice_sat_per_ph_day:
      r.max_overpay_vs_hashprice_sat_per_eh_day !== null
        ? r.max_overpay_vs_hashprice_sat_per_eh_day / EH_PER_PH
        : null,
  };
}
