/**
 * #266: configurable StatsBar - operator-pickable tile slots.
 *
 * Replaces the build-611 hardcoded 6-tile grid. Each slot has a
 * dropdown over the catalogue declared in @hashrate-autopilot/shared.
 * Click anywhere on a tile's header row to open the picker; the
 * picker is the *single* customisation surface (replace / remove /
 * add another tile - all from the same dropdown). No separate
 * "rearrange mode" gate for tiles, because the operator's design-
 * interview pick was "same flow whether you're in rearrange mode or
 * not" - matching the cleanest path the question listed.
 *
 * Choice persists to `config.dashboard_tiles` (daemon-side, follows
 * the operator across browsers and devices).
 *
 * Pointer-events note: the picker controls (header button + + add)
 * carry `pointer-events-auto` because the parent SortableDashboard
 * applies `pointer-events-none` to block content while the operator
 * is in rearrange mode (#244, intentional - stops a stray tap from
 * firing a button mid-drag). For tiles we WANT that tap to fire,
 * because the only way to customise the layout *is* a tap. The
 * override is local to the picker controls; the rest of the tile
 * content stays inert during rearrange so the chart-pan-during-drag
 * problem #244 was protecting against doesn't regress.
 *
 * Data sources are the queries Status already runs (statsQuery,
 * statusQuery, oceanQuery). Tiles whose data isn't loaded yet (or
 * isn't enabled on this install) render an em-dash; they're still
 * pickable so the operator can lay out their dashboard before the
 * underlying integration is configured.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useMemo, useRef, useState, useEffect, useLayoutEffect } from 'react';
import { Tooltip } from './Tooltip';

import {
  DEFAULT_DASHBOARD_TILES,
  MAX_DASHBOARD_TILES,
  TILE_CATALOGUE,
  type DashboardTileId,
} from '@hashrate-autopilot/shared';

import { useDenomination } from '../lib/denomination';
import { useLocale } from '../lib/locale';
import { formatNumber } from '../lib/format';
import { SatSymbol } from './SatSymbol';
import type { StatsResponse, StatusResponse, OceanResponse } from '../lib/api';

export interface TilesBarProps {
  readonly tileIds: ReadonlyArray<DashboardTileId>;
  readonly statsData: StatsResponse | undefined;
  readonly statusData: StatusResponse | undefined;
  readonly oceanData: OceanResponse | undefined;
  /**
   * Called when the operator adds, removes, or swaps a tile. The new
   * full list (in render order) is passed; caller persists to
   * `config.dashboard_tiles`.
   */
  readonly onTilesChange: (next: DashboardTileId[]) => void;
}

interface TileResult {
  readonly value: string;
  readonly tooltip?: string;
  readonly color?: string;
}

interface TileCtx {
  readonly stats: StatsResponse | undefined;
  readonly status: StatusResponse | undefined;
  readonly ocean: OceanResponse | undefined;
  readonly intlLocale: string;
  readonly denomination: ReturnType<typeof useDenomination>;
}

const EM_DASH = '—';
const DASH: TileResult = { value: EM_DASH };

function fmtPct(v: number | null | undefined, digits = 1, intlLocale = 'en-US'): string {
  if (v === null || v === undefined) return EM_DASH;
  return `${formatNumber(v, { minimumFractionDigits: digits, maximumFractionDigits: digits }, intlLocale)}%`;
}

function fmtX(v: number | null | undefined, intlLocale = 'en-US'): string {
  if (v === null || v === undefined) return EM_DASH;
  return `${formatNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 }, intlLocale)}×`;
}

const TILE_RENDERERS: Record<DashboardTileId, (ctx: TileCtx) => TileResult> = {
  uptime: ({ stats, intlLocale }) => ({
    value: fmtPct(stats?.uptime_pct ?? null, 1, intlLocale),
    tooltip: t`Duration-weighted % of time with delivered hashrate > 0, computed over the selected chart range. Each tick is weighted by its actual duration so gaps after restarts count proportionally. Updates with the range selector.`,
    color:
      stats?.uptime_pct == null
        ? 'text-slate-400'
        : stats.uptime_pct >= 90
          ? 'text-emerald-300'
          : stats.uptime_pct >= 50
            ? 'text-amber-300'
            : 'text-red-300',
  }),
  avg_braiins: ({ stats, intlLocale, denomination }) => ({
    value: denomination.formatHashrate(stats?.avg_hashrate_ph ?? null, intlLocale),
    tooltip: t`Duration-weighted average of the hashrate Braiins reports delivering over the selected range. Includes downtime in the denominator so a bad stretch shows up here, not just on the live card.`,
  }),
  avg_datum: ({ stats, intlLocale, denomination }) => ({
    value: denomination.formatHashrate(stats?.avg_datum_hashrate_ph ?? null, intlLocale),
    tooltip: t`Duration-weighted average of the hashrate Datum measures at the gateway over the selected range. A sustained gap below Avg Braiins means Braiins is billing for hashrate Datum never saw arrive.`,
  }),
  avg_ocean: ({ stats, intlLocale, denomination }) => ({
    value: denomination.formatHashrate(stats?.avg_ocean_hashrate_ph ?? null, intlLocale),
    tooltip: t`Duration-weighted average of the hashrate Ocean credits to our payout address over the selected range. A sustained gap below Avg Braiins / Avg Datum means the pool isn't crediting work we think we delivered.`,
  }),
  avg_cost_delivered: ({ stats, intlLocale, denomination }) => ({
    value:
      stats?.avg_cost_per_ph_sat_per_ph_day != null
        ? denomination.formatSatPerPhDay(Math.round(stats.avg_cost_per_ph_sat_per_ph_day), intlLocale)
        : EM_DASH,
    tooltip: t`Average effective rate over the selected range - what Braiins actually charged per PH/day delivered. Spend-weighted; zero-delivery periods contribute zero to both sides.`,
  }),
  avg_cost_vs_hashprice: ({ stats, intlLocale, denomination }) => ({
    value:
      stats?.avg_overpay_vs_hashprice_sat_per_ph_day != null
        ? denomination.formatSatPerPhDay(Math.round(stats.avg_overpay_vs_hashprice_sat_per_ph_day), intlLocale)
        : EM_DASH,
    tooltip: t`(avg cost delivered) minus the spend-weighted average hashprice during periods we were actually billed, computed over the selected range. Negative = paid below break-even.`,
    color:
      stats?.avg_overpay_vs_hashprice_sat_per_ph_day == null
        ? 'text-slate-100'
        : stats.avg_overpay_vs_hashprice_sat_per_ph_day < 0
          ? 'text-emerald-300'
          : stats.avg_overpay_vs_hashprice_sat_per_ph_day > 0
            ? 'text-red-300'
            : 'text-slate-100',
  }),
  uptime_bid_coverage: ({ stats, intlLocale }) => ({
    value: fmtPct(stats?.uptime_bid_coverage_pct ?? null, 1, intlLocale),
    tooltip: t`% of the window with an active Braiins bid. Low = orderbook didn't cooperate ("expected" downtime - nothing matched your criteria), not a failure on your side.`,
  }),
  uptime_delivery_when_bid_active: ({ stats, intlLocale }) => ({
    value: fmtPct(stats?.uptime_delivery_when_bid_active_pct ?? null, 1, intlLocale),
    tooltip: t`% of the bid-active time that actually delivered hashrate. Low = hardware / connection / Datum-side failure while a bid was up ("unexpected" downtime).`,
  }),
  hashrate_target: ({ status, intlLocale, denomination }) => ({
    value: denomination.formatHashrate(
      status?.config_summary?.effective_target_hashrate_ph ?? null,
      intlLocale,
    ),
    tooltip: t`Live effective hashrate target. Steps to cheap_target_hashrate_ph when cheap-mode engages, back to target_hashrate_ph when it disengages.`,
  }),
  avg_overpay_intent: ({ stats, intlLocale, denomination }) => ({
    value:
      stats?.avg_intent_overpay_sat_per_ph_day != null
        ? denomination.formatSatPerPhDay(Math.round(stats.avg_intent_overpay_sat_per_ph_day), intlLocale)
        : EM_DASH,
    tooltip: t`Average overpay above the fillable ask the controller chose to set as the bid. Measures how aggressive the autopilot was being, separate from how much was actually billed.`,
  }),
  avg_overpay_settled: ({ stats, intlLocale, denomination }) => ({
    value:
      stats?.avg_settled_overpay_sat_per_ph_day != null
        ? denomination.formatSatPerPhDay(Math.round(stats.avg_settled_overpay_sat_per_ph_day), intlLocale)
        : EM_DASH,
    tooltip: t`Average overpay above the fillable ask on the bid price the controller actually had live (post-edit-deadband). Measures what the operator paid for, separate from what the controller intended.`,
  }),
  hashprice_now: ({ ocean, intlLocale, denomination }) => ({
    value:
      ocean?.user?.hashprice_sat_per_ph_day != null
        ? denomination.formatSatPerPhDay(Math.round(ocean.user.hashprice_sat_per_ph_day), intlLocale)
        : EM_DASH,
    tooltip: t`Current Ocean hashprice (sat per PH per day at the pool's most recent rolling window). The break-even reference the controller bids against.`,
  }),
  pool_blocks_30d: ({ ocean, intlLocale }) => ({
    value: ocean?.blocks_30d != null ? formatNumber(ocean.blocks_30d, {}, intlLocale) : EM_DASH,
    tooltip: t`Ocean blocks found in the past 30 days. Used by the pool-luck calculation as the numerator.`,
  }),
  pool_luck_24h: ({ ocean, intlLocale }) => ({
    value: fmtX(ocean?.pool_luck_24h ?? null, intlLocale),
    tooltip: t`Ocean pool luck over the past 24 h: actual blocks found ÷ statistically expected blocks at the pool's hashrate. >1 = lucky, <1 = unlucky.`,
  }),
  pool_luck_7d: ({ ocean, intlLocale }) => ({
    value: fmtX(ocean?.pool_luck_7d ?? null, intlLocale),
    tooltip: t`Ocean pool luck over the past 7 days. Same formula as 24 h, longer window.`,
  }),
  pool_luck_30d: ({ ocean, intlLocale }) => ({
    value: fmtX(ocean?.pool_luck_30d ?? null, intlLocale),
    tooltip: t`Ocean pool luck over the past 30 days. Longest-window luck reading.`,
  }),
  share_log_pct: ({ ocean, intlLocale }) => ({
    value: fmtPct(ocean?.user?.share_log_pct ?? null, 4, intlLocale),
    tooltip: t`Your share of Ocean's reward window. Approximately your hashrate ÷ pool hashrate; drives the unpaid-earnings line on the price chart.`,
  }),
  share_rejection_pct: () => ({
    value: EM_DASH,
    tooltip: t`Share-rejection rate. Tile data source pending - currently shown only on the chart's right axis. Will populate in a follow-up.`,
  }),
  wallet_runway_days: ({ status, intlLocale }) => {
    const balance = status?.balances?.[0]?.total_balance_sat ?? null;
    const dailySpend = status?.actual_spend_per_day_sat_3h ?? null;
    if (balance === null || dailySpend === null || dailySpend <= 0) return DASH;
    const days = balance / dailySpend;
    const text =
      days >= 10
        ? formatNumber(Math.round(days), {}, intlLocale)
        : formatNumber(days, { minimumFractionDigits: 1, maximumFractionDigits: 1 }, intlLocale);
    return {
      // #266 follow-up: prefer the full word over a single-letter "d"
      // suffix. There's room for it and "17d" reads as a typo.
      value: `${text} ${t`days`}`,
      tooltip: t`Days of Braiins wallet runway at the current 3 h average spend rate. = total balance ÷ daily spend. Doesn't account for upcoming deposits.`,
      color:
        days >= 14 ? 'text-emerald-300' : days >= 7 ? 'text-amber-300' : 'text-red-300',
    };
  },
  bitaxe_fleet_hashrate: () => ({
    value: EM_DASH,
    tooltip: t`Bitaxe fleet hashrate. Tile data source pending - currently in the Bitaxe miners section. Will populate in a follow-up.`,
  }),
  bitaxe_fleet_power: () => ({
    value: EM_DASH,
    tooltip: t`Bitaxe fleet power draw. Tile data source pending - currently in the Bitaxe miners section. Will populate in a follow-up.`,
  }),
  bitaxe_fleet_efficiency_j_per_th: () => ({
    value: EM_DASH,
    tooltip: t`Bitaxe fleet efficiency in J/TH. Tile data source pending - currently in the Bitaxe miners section. Will populate in a follow-up.`,
  }),
};

function labelFor(id: DashboardTileId): string {
  switch (id) {
    case 'uptime': return t`uptime`;
    case 'avg_braiins': return t`avg braiins`;
    case 'avg_datum': return t`avg datum`;
    case 'avg_ocean': return t`avg ocean`;
    case 'avg_cost_delivered': return t`avg cost delivered`;
    case 'avg_cost_vs_hashprice': return t`avg cost vs hashprice`;
    case 'uptime_bid_coverage': return t`bid coverage`;
    case 'uptime_delivery_when_bid_active': return t`delivery rate (while bidding)`;
    case 'hashrate_target': return t`hashrate target`;
    case 'avg_overpay_intent': return t`avg overpay (intent)`;
    case 'avg_overpay_settled': return t`avg overpay (settled)`;
    case 'hashprice_now': return t`hashprice now`;
    case 'pool_blocks_30d': return t`pool blocks 30d`;
    case 'pool_luck_24h': return t`pool luck 24h`;
    case 'pool_luck_7d': return t`pool luck 7d`;
    case 'pool_luck_30d': return t`pool luck 30d`;
    case 'share_log_pct': return t`share log %`;
    case 'share_rejection_pct': return t`share rejection`;
    case 'wallet_runway_days': return t`wallet runway`;
    case 'bitaxe_fleet_hashrate': return t`Bitaxe hashrate`;
    case 'bitaxe_fleet_power': return t`Bitaxe power`;
    case 'bitaxe_fleet_efficiency_j_per_th': return t`Bitaxe efficiency`;
  }
}

/**
 * Split a formatted value like "46,362 sat/PH/day" or "718 sat/PH/day"
 * into a big-number half and a small-caption unit half, so the tile
 * matches the original StatCard idiom: large mono number above, slim
 * grey unit below. The original implementation lives in Status.tsx;
 * duplicated here to avoid coupling the TilesBar to a private helper.
 */
function splitUnit(v: string): { num: string; unit: string } | null {
  const spaced = v.match(
    /^(.+?)\s+((?:sat|₿)\/(?:TH|PH|EH)\/day|(?:TH|PH|EH)\/s|PH·h|sat|₿)(\s*(?:\(.*\))?)$/,
  );
  if (spaced?.[1] && spaced[2]) return { num: spaced[1], unit: spaced[2] + (spaced[3] ?? '') };
  const usdRate = v.match(/^(.+?)(\/(?:TH|PH|EH)\/day)$/);
  if (usdRate?.[1] && usdRate[2]) return { num: usdRate[1], unit: usdRate[2] };
  const pct = v.match(/^(.+?)(%)$/);
  if (pct?.[1] && pct[2]) return { num: pct[1], unit: pct[2] };
  // "17 days" / "1.5 days" - localised words emitted by the wallet
  // runway renderer.
  const wordSuffix = v.match(/^(.+?)\s+([\p{L}]+)$/u);
  if (wordSuffix?.[1] && wordSuffix[2] && /[\p{L}]/u.test(wordSuffix[2])) {
    return { num: wordSuffix[1], unit: wordSuffix[2] };
  }
  return null;
}

/** Render the unit half with the muted-grey "subtitle" look. */
function UnitCaption({ unit }: { unit: string }) {
  const { i18n } = useLingui();
  void i18n;
  const phDayLabel = t`/PH/day`;
  const localized = unit.replace('/PH/day', phDayLabel);
  if (localized === 'sat' || localized === '₿') {
    return (
      <span className="inline-block w-3 text-center">
        {localized === 'sat' ? <SatSymbol className="opacity-70" /> : localized}
      </span>
    );
  }
  if (localized === '%') {
    return <span className="inline-block w-3 text-center">{localized}</span>;
  }
  if (localized.startsWith('sat')) {
    return (
      <>
        <SatSymbol className="opacity-70" />
        {localized.slice(3)}
      </>
    );
  }
  return <>{localized}</>;
}

export function TilesBar({
  tileIds,
  statsData,
  statusData,
  oceanData,
  onTilesChange,
}: TilesBarProps) {
  const { i18n } = useLingui();
  void i18n;
  const { intlLocale } = useLocale();
  const denomination = useDenomination();

  // Render the operator's saved tile list, or fall back to defaults
  // when they haven't customised. Empty array doesn't mean "no
  // tiles" - it means "use the defaults" (the dashboard's standing
  // look). The operator removes the last tile by clicking ×; if they
  // remove all of them the bar reverts to defaults on next render so
  // the page is never tile-less and unrecoverable.
  const effective = tileIds.length === 0 ? DEFAULT_DASHBOARD_TILES : tileIds;

  const ctx: TileCtx = {
    stats: statsData,
    status: statusData,
    ocean: oceanData,
    intlLocale: intlLocale ?? 'en-US',
    denomination,
  };

  const replaceAt = (idx: number, next: DashboardTileId) => {
    const arr = [...effective] as DashboardTileId[];
    arr[idx] = next;
    onTilesChange(arr);
  };
  const removeAt = (idx: number) => {
    const arr = [...effective] as DashboardTileId[];
    arr.splice(idx, 1);
    onTilesChange(arr);
  };
  const addTile = (id: DashboardTileId) => {
    onTilesChange([...effective, id] as DashboardTileId[]);
  };

  return (
    // Wrapper holds both the bar and the floating "+ add" affordance
    // anchored to the section corner. `pointer-events-auto` re-enables
    // clicks when SortableDashboard wraps the indicators block in
    // its rearrange-inert layer.
    <div className="relative pointer-events-auto">
      {/* #266 follow-up: `auto-rows-fr` forces every tile to match
          the tallest in the row so pool-luck (no unit caption) and
          uptime (with caption) share a baseline. `auto-fit` keeps
          the row reflowing past 6 columns on wide screens. */}
      <section className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(160px,1fr))] auto-rows-fr">
        {effective.map((id, idx) => (
          <TileSlot
            key={`${id}-${idx}`}
            id={id}
            inUse={effective}
            result={(TILE_RENDERERS[id] ?? (() => DASH))(ctx)}
            onReplace={(next) => replaceAt(idx, next)}
            onRemove={effective.length > 1 ? () => removeAt(idx) : undefined}
          />
        ))}
      </section>
      {/*
        Small `+` button anchored to the section's top-right
        corner, OUTSIDE the grid. Always visible (no hover gate
        because touch screens never fire hover). Click opens the
        catalogue picker. No more dashed ghost-tile in the row.
      */}
      {effective.length < MAX_DASHBOARD_TILES && (
        <FloatingAddButton excluded={effective} onAdd={addTile} />
      )}
    </div>
  );
}

function FloatingAddButton({
  excluded,
  onAdd,
}: {
  excluded: ReadonlyArray<DashboardTileId>;
  onAdd: (id: DashboardTileId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // #266 follow-up: restyled to mirror the "right axis [select]"
  // affordance used elsewhere on the page - inline label + chevron
  // sitting on the same row as a select-style trigger. Anchored
  // below the period-selector row (which moved left to clear this
  // space) at the top-right of the indicators block.
  return (
    <div ref={ref} className="absolute -top-7 right-0 flex items-center gap-2 pointer-events-auto">
      <span className="text-xs text-slate-400 uppercase tracking-wider">
        <Trans>add tile</Trans>
      </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t`Add a tile`}
        className="bg-slate-800 border border-slate-700 rounded px-2 py-0.5 text-xs text-slate-200 hover:bg-slate-700 flex items-center gap-1 min-w-[5rem]"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
        <span className="flex-1 text-left text-slate-400">
          <Trans>pick…</Trans>
        </span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        // Picker dropdown opens BELOW the button and anchored to the
        // RIGHT edge (right-0) so it grows leftward into the page
        // rather than rightward off the screen.
        <div className="absolute z-30 right-0 top-full mt-1 pointer-events-auto">
          <TilePickerDropdown
            inUse={excluded}
            onPick={(id) => {
              onAdd(id);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

interface TileSlotProps {
  readonly id: DashboardTileId;
  readonly inUse: ReadonlyArray<DashboardTileId>;
  readonly result: TileResult;
  readonly onReplace: (id: DashboardTileId) => void;
  readonly onRemove: (() => void) | undefined;
}

function TileSlot({ id, inUse, result, onReplace, onRemove }: TileSlotProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const split = splitUnit(result.value);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const chevronRef = useRef<HTMLButtonElement>(null);

  // #266 follow-up: styled <Tooltip> for the label hover instead of
  // the browser's default `title=` chrome. Question-mark icon next
  // to the label signals hoverable detail without taking width.
  const titleContent = result.tooltip ? (
    <Tooltip text={result.tooltip}>
      <span className="text-xs uppercase tracking-wider text-slate-100 break-words cursor-help inline-flex items-baseline gap-1">
        <span>{labelFor(id)}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500 shrink-0 self-center" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </svg>
      </span>
    </Tooltip>
  ) : (
    <span className="text-xs uppercase tracking-wider text-slate-100 break-words">
      {labelFor(id)}
    </span>
  );

  return (
    <div
      ref={ref}
      className="relative pointer-events-auto group bg-slate-900 border border-slate-800 rounded-lg p-4 hover:border-slate-700"
    >
      <div className="flex flex-col h-full">
        <div className="mb-2 min-h-8 leading-4 text-center pr-5">{titleContent}</div>
        <div className={`text-2xl font-mono tabular-nums text-center ${result.color ?? 'text-slate-100'}`}>
          {split ? split.num : result.value}
        </div>
        <div className="text-xs text-slate-500 mt-0.5 text-center min-h-[1.25rem]">
          {split ? <UnitCaption unit={split.unit} /> : ' '}
        </div>
      </div>
      <button
        type="button"
        ref={chevronRef}
        onClick={() => setOpen((v) => !v)}
        aria-label={t`Swap tile`}
        className="absolute top-2.5 right-2.5 text-slate-500 hover:text-amber-300 leading-none"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <TilePickerDropdown
          currentId={id}
          inUse={inUse}
          anchorRef={chevronRef}
          onPick={(next) => {
            onReplace(next);
            setOpen(false);
          }}
          onRemove={
            onRemove
              ? () => {
                  onRemove();
                  setOpen(false);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

interface PickerProps {
  readonly currentId?: DashboardTileId;
  readonly inUse: ReadonlyArray<DashboardTileId>;
  readonly onPick: (id: DashboardTileId) => void;
  readonly onRemove?: () => void;
  /**
   * #266 follow-up: anchor element to position the dropdown next to
   * (the tile's chevron button). Without this the dropdown opened
   * from the tile's left edge and could overflow the viewport when
   * the tile sat near the right edge. The dropdown now opens from
   * the anchor's top-right and gets clamped to fit the viewport.
   */
  readonly anchorRef?: React.RefObject<HTMLElement | null>;
}

function TilePickerDropdown({ currentId, inUse, onPick, onRemove, anchorRef }: PickerProps) {
  const inUseSet = useMemo(() => new Set(inUse), [inUse]);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0,
    top: 0,
    ready: anchorRef === undefined,
  });

  useLayoutEffect(() => {
    if (!anchorRef?.current || !ref.current) return;
    const anchorRect = anchorRef.current.getBoundingClientRect();
    const tipRect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    // Default placement: below the anchor, right-aligned so the
    // dropdown grows leftward into the page rather than rightward off
    // the screen.
    let left = anchorRect.right - tipRect.width;
    let top = anchorRect.bottom + 4;
    if (left < margin) left = margin;
    if (left + tipRect.width > vw - margin) left = vw - tipRect.width - margin;
    if (top + tipRect.height > vh - margin) {
      // Not enough room below; flip above the anchor.
      const above = anchorRect.top - tipRect.height - 4;
      if (above >= margin) top = above;
    }
    if (top < margin) top = margin;
    setPos({ left, top, ready: true });
  }, [anchorRef]);

  const grouped = useMemo(() => {
    const m = new Map<string, typeof TILE_CATALOGUE[number][]>();
    for (const meta of TILE_CATALOGUE) {
      const arr = m.get(meta.group) ?? [];
      arr.push(meta);
      m.set(meta.group, arr);
    }
    return [...m.entries()];
  }, []);

  // When `anchorRef` is supplied the dropdown is fixed-positioned and
  // viewport-clamped; otherwise (legacy FloatingAddButton path) it
  // falls back to `absolute left-0 top-full mt-1` relative to its
  // parent.
  const positioned = anchorRef !== undefined;

  return (
    <div
      ref={ref}
      className={`${
        positioned ? 'fixed' : 'absolute left-0 top-full mt-1'
      } z-30 w-72 max-h-80 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-2 text-xs pointer-events-auto tile-picker-scroll ${pos.ready ? '' : 'invisible'}`}
      style={positioned ? { left: pos.left, top: pos.top } : undefined}
    >
      {grouped.map(([group, items]) => (
        <div key={group} className="mb-2 last:mb-0">
          <div className="text-[9px] uppercase tracking-wider text-slate-500 px-1 mb-1">
            {group}
          </div>
          <ul className="space-y-px">
            {items.map((meta) => {
              const isCurrent = meta.id === currentId;
              const isElsewhere = !isCurrent && inUseSet.has(meta.id);
              // #266 follow-up: picking a tile that's already in
              // another slot used to silently duplicate it, which
              // made the operator's current slot look like it had
              // "disappeared". Disabled now - operator removes the
              // other slot first if they want to move it.
              const disabled = isElsewhere;
              return (
                <li key={meta.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return;
                      onPick(meta.id);
                    }}
                    className={`w-full text-left px-2 py-0.5 rounded ${
                      disabled
                        ? 'text-slate-600 cursor-not-allowed'
                        : isCurrent
                          ? 'text-amber-300 font-medium hover:bg-slate-800'
                          : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {labelFor(meta.id)}
                    {isCurrent && (
                      <span className="ml-1 text-[9px] text-slate-500">
                        <Trans>(current)</Trans>
                      </span>
                    )}
                    {isElsewhere && (
                      <span className="ml-1 text-[9px] text-slate-600">
                        <Trans>(already in use)</Trans>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {onRemove && (
        <div className="border-t border-slate-800 mt-2 pt-2">
          <button
            type="button"
            onClick={onRemove}
            className="w-full text-left px-2 py-0.5 rounded text-red-400 hover:bg-red-900/20"
          >
            <Trans>Remove this tile</Trans>
          </button>
        </div>
      )}
    </div>
  );
}

