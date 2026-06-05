/**
 * #266: configurable StatsBar - operator-pickable tile slots.
 *
 * Replaces the build-611 hardcoded 6-tile grid. Each slot is a
 * dropdown over the catalogue declared in @hashrate-autopilot/shared.
 * Slot count is variable: add tiles up to MAX_DASHBOARD_TILES, remove
 * tiles via the X button in rearrange mode. Order persists to
 * `config.dashboard_tiles` (daemon-side, follows the operator across
 * browsers).
 *
 * Data sources are the queries Status already runs (statsQuery,
 * statusQuery, oceanQuery). Tiles whose data isn't loaded yet (or
 * isn't enabled on this install) render an em-dash; they're still
 * pickable so the operator can lay out their dashboard before the
 * underlying integration is configured.
 *
 * Rearrange mode (the X button + add affordance) reuses
 * `cardOrderContext.rearranging` from #244, so one toggle in the
 * header puts the whole Status page into edit mode rather than two
 * separate toggles for blocks vs tiles.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useMemo, useRef, useState, useEffect } from 'react';

import {
  DEFAULT_DASHBOARD_TILES,
  MAX_DASHBOARD_TILES,
  TILE_CATALOGUE,
  type DashboardTileId,
} from '@hashrate-autopilot/shared';

import { useCardOrderContext } from '../lib/cardOrderContext';
import { useDenomination } from '../lib/denomination';
import { useLocale } from '../lib/locale';
import { formatNumber } from '../lib/format';
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

/** Format a 0-100 percentage with N decimals, returning em-dash on null. */
function fmtPct(v: number | null | undefined, digits = 1, intlLocale = 'en-US'): string {
  if (v === null || v === undefined) return EM_DASH;
  return `${formatNumber(v, { minimumFractionDigits: digits, maximumFractionDigits: digits }, intlLocale)}%`;
}

function fmtX(v: number | null | undefined, intlLocale = 'en-US'): string {
  if (v === null || v === undefined) return EM_DASH;
  return `${formatNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 }, intlLocale)}×`;
}

/** Renderer per tile id. Returns the value + tooltip the StatCard shows. */
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
    tooltip: t`Share-rejection rate. Tile data source pending — currently shown only on the chart's right axis. Will populate in a follow-up.`,
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
      value: `${text} d`,
      tooltip: t`Days of Braiins wallet runway at the current 3 h average spend rate. = total balance ÷ daily spend. Doesn't account for upcoming deposits.`,
      color:
        days >= 14 ? 'text-emerald-300' : days >= 7 ? 'text-amber-300' : 'text-red-300',
    };
  },
  bitaxe_fleet_hashrate: () => ({
    value: EM_DASH,
    tooltip: t`Bitaxe fleet hashrate. Tile data source pending — currently in the Bitaxe miners section. Will populate in a follow-up.`,
  }),
  bitaxe_fleet_power: () => ({
    value: EM_DASH,
    tooltip: t`Bitaxe fleet power draw. Tile data source pending — currently in the Bitaxe miners section. Will populate in a follow-up.`,
  }),
  bitaxe_fleet_efficiency_j_per_th: () => ({
    value: EM_DASH,
    tooltip: t`Bitaxe fleet efficiency in J/TH. Tile data source pending — currently in the Bitaxe miners section. Will populate in a follow-up.`,
  }),
};

/** Translated label for a catalogue id. Maps to the labelKey verbatim. */
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
  const cardOrder = useCardOrderContext();
  const rearranging = cardOrder.rearranging;

  // Render the operator's saved tile list, or fall back to defaults
  // when they haven't customised. Empty array doesn't mean "no
  // tiles" - it means "use the defaults" (the dashboard's standing
  // look). The operator removes tiles in rearrange mode and an empty
  // dashboard_tiles is interpreted as un-customised, not as "show
  // nothing." A truly-empty bar would be unusable.
  const effective = tileIds.length === 0 ? DEFAULT_DASHBOARD_TILES : tileIds;

  const ctx: TileCtx = {
    stats: statsData,
    status: statusData,
    ocean: oceanData,
    intlLocale: intlLocale ?? 'en-US',
    denomination,
  };

  const replaceAt = (idx: number, next: DashboardTileId) => {
    const arr = [...effective];
    arr[idx] = next;
    onTilesChange(arr as DashboardTileId[]);
  };
  const removeAt = (idx: number) => {
    const arr = [...effective];
    arr.splice(idx, 1);
    onTilesChange(arr as DashboardTileId[]);
  };
  const addAt = (id: DashboardTileId) => {
    onTilesChange([...effective, id] as DashboardTileId[]);
  };

  return (
    <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {effective.map((id, idx) => (
        <TileSlot
          key={`${id}-${idx}`}
          id={id}
          index={idx}
          result={(TILE_RENDERERS[id] ?? (() => DASH))(ctx)}
          rearranging={rearranging}
          onReplace={(next) => replaceAt(idx, next)}
          onRemove={() => removeAt(idx)}
        />
      ))}
      {rearranging && effective.length < MAX_DASHBOARD_TILES && (
        <AddTileButton excluded={effective} onAdd={addAt} />
      )}
    </section>
  );
}

interface TileSlotProps {
  readonly id: DashboardTileId;
  readonly index: number;
  readonly result: TileResult;
  readonly rearranging: boolean;
  readonly onReplace: (id: DashboardTileId) => void;
  readonly onRemove: () => void;
}

function TileSlot({ id, result, rearranging, onReplace, onRemove }: TileSlotProps) {
  const removeLabel = t`Remove tile`;
  return (
    <div className="relative bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 group">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5 flex items-center gap-1">
        <span title={result.tooltip ?? labelFor(id)} className="truncate cursor-help">
          {labelFor(id)}
        </span>
        {rearranging && (
          <TilePicker currentId={id} onPick={onReplace} />
        )}
        {rearranging && (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto -mr-1 text-slate-500 hover:text-red-400 text-sm leading-none"
            title={removeLabel}
            aria-label={removeLabel}
          >
            ×
          </button>
        )}
      </div>
      <div
        className={`text-lg font-mono leading-tight ${result.color ?? 'text-slate-100'}`}
      >
        {result.value}
      </div>
    </div>
  );
}

/**
 * Click-to-swap dropdown. Lists every catalogue tile grouped by
 * `group`, with the operator's currently-selected `currentId`
 * highlighted. Click an entry to swap; close on outside-click.
 */
function TilePicker({
  currentId,
  onPick,
}: {
  currentId: DashboardTileId;
  onPick: (id: DashboardTileId) => void;
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

  // Group catalogue by `.group` for a tidy dropdown.
  const grouped = useMemo(() => {
    const m = new Map<string, typeof TILE_CATALOGUE[number][]>();
    for (const meta of TILE_CATALOGUE) {
      const arr = m.get(meta.group) ?? [];
      arr.push(meta);
      m.set(meta.group, arr);
    }
    return [...m.entries()];
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-slate-500 hover:text-amber-300 text-[10px] leading-none"
        title={t`Swap tile`}
        aria-label={t`Swap tile`}
      >
        ▾
      </button>
      {open && (
        <div className="absolute z-30 left-0 mt-1 w-64 max-h-72 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-2 text-xs">
          {grouped.map(([group, items]) => (
            <div key={group} className="mb-2 last:mb-0">
              <div className="text-[9px] uppercase tracking-wider text-slate-500 px-1 mb-1">
                {group}
              </div>
              <ul className="space-y-px">
                {items.map((meta) => {
                  const isCurrent = meta.id === currentId;
                  return (
                    <li key={meta.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onPick(meta.id);
                          setOpen(false);
                        }}
                        className={`w-full text-left px-2 py-0.5 rounded hover:bg-slate-800 ${
                          isCurrent ? 'text-amber-300' : 'text-slate-300'
                        }`}
                      >
                        {labelFor(meta.id)}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "+ add" affordance shown at the end of the row in rearrange mode.
 * Mirrors the TilePicker's dropdown shape but adds (rather than
 * replaces).
 */
function AddTileButton({
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

  const excludedSet = useMemo(() => new Set(excluded), [excluded]);
  const grouped = useMemo(() => {
    const m = new Map<string, typeof TILE_CATALOGUE[number][]>();
    for (const meta of TILE_CATALOGUE) {
      const arr = m.get(meta.group) ?? [];
      arr.push(meta);
      m.set(meta.group, arr);
    }
    return [...m.entries()];
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-full min-h-[3rem] bg-slate-900 border border-dashed border-slate-700 rounded-lg text-slate-500 hover:text-amber-300 hover:border-amber-500/40 text-xs"
        title={t`Add a tile`}
      >
        + <Trans>add</Trans>
      </button>
      {open && (
        <div className="absolute z-30 left-0 mt-1 w-64 max-h-72 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-2 text-xs">
          {grouped.map(([group, items]) => (
            <div key={group} className="mb-2 last:mb-0">
              <div className="text-[9px] uppercase tracking-wider text-slate-500 px-1 mb-1">
                {group}
              </div>
              <ul className="space-y-px">
                {items.map((meta) => {
                  const inUse = excludedSet.has(meta.id);
                  return (
                    <li key={meta.id}>
                      <button
                        type="button"
                        disabled={inUse}
                        onClick={() => {
                          onAdd(meta.id);
                          setOpen(false);
                        }}
                        className={`w-full text-left px-2 py-0.5 rounded ${
                          inUse
                            ? 'text-slate-600 cursor-not-allowed'
                            : 'text-slate-300 hover:bg-slate-800'
                        }`}
                      >
                        {labelFor(meta.id)}
                        {inUse && (
                          <span className="ml-1 text-[9px] text-slate-600">
                            <Trans>(in use)</Trans>
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
