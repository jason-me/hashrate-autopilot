/**
 * #256 v2: flat-table /history page.
 *
 * Replaces the build-616 collapsible per-bid view. Operator feedback
 * was clear: "when did the last edit_speed happen?" is the question,
 * and that's a flat-table-with-filters question, not a per-bid
 * grouping one.
 *
 * Layout: toolbar of filters at top + flat table + infinite scroll.
 * Server pages 100 events at a time using a `before_id` cursor.
 * Per-bid grouping retired; bid renders as a column with truncated
 * id + hover-for-full. Reason column dropped; the action + price +
 * fillable columns carry the meaningful change information.
 */

import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  api,
  type BidHistoryFilters,
  type BidHistoryFlatEvent,
  type BidEventView,
} from '../lib/api';
import { useDenomination } from '../lib/denomination';
import { useFormatters } from '../lib/locale';
import { formatNumber } from '../lib/format';

const PAGE_SIZE = 100;
type Kind = NonNullable<BidHistoryFilters['kinds']>[number];

export function History() {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const denomination = useDenomination();
  const [filters, setFilters] = useState<BidHistoryFilters>({});

  const query = useInfiniteQuery({
    queryKey: ['bid-history-flat', filters],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api.bidHistoryFlatEvents(filters, pageParam, PAGE_SIZE),
    getNextPageParam: (last) => last.next_cursor_id ?? undefined,
    refetchInterval: 60_000,
  });

  const events: BidHistoryFlatEvent[] = useMemo(
    () => query.data?.pages.flatMap((p) => p.events) ?? [],
    [query.data],
  );

  // Auto-load next page when the sentinel near the bottom enters view.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && query.hasNextPage && !query.isFetchingNextPage) {
        void query.fetchNextPage();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [query]);

  return (
    <div className="space-y-3">
      <h2 className="text-sm uppercase tracking-wider text-slate-100">
        <Trans>Order history</Trans>
      </h2>
      <Toolbar filters={filters} onChange={setFilters} />
      <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-slate-500 uppercase tracking-wider bg-slate-950/40">
            <tr>
              <th className="text-left font-normal py-1.5 px-3 whitespace-nowrap"><Trans>When</Trans></th>
              <th className="text-left font-normal py-1.5 px-3"><Trans>Bid</Trans></th>
              <th className="text-left font-normal py-1.5 px-3"><Trans>Action</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Price before</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Price after</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Δ price</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Fillable</Trans></th>
              <th className="text-right font-normal py-1.5 px-3"><Trans>Speed</Trans></th>
              <th className="text-left font-normal py-1.5 px-3"><Trans>Source</Trans></th>
            </tr>
          </thead>
          <tbody className="text-slate-200">
            {events.map((e) => (
              <EventRow key={e.id} event={e} fmt={fmt} denomination={denomination} />
            ))}
            {events.length === 0 && !query.isPending && (
              <tr>
                <td colSpan={9} className="px-3 py-4 text-center text-xs text-slate-500 italic">
                  <Trans>No events match the current filters.</Trans>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Sentinel + manual fallback button. */}
      <div ref={sentinelRef} />
      {query.hasNextPage && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="text-xs text-amber-300 border border-amber-700 rounded px-3 py-1 hover:bg-amber-500/10 disabled:opacity-40"
          >
            {query.isFetchingNextPage ? <Trans>Loading…</Trans> : <Trans>Load more</Trans>}
          </button>
        </div>
      )}
      <div className="text-[10px] text-slate-600 text-center pt-1">
        {events.length}{' '}
        {query.hasNextPage ? <Trans>events loaded; scroll for more</Trans> : <Trans>events (end of history)</Trans>}
      </div>
    </div>
  );
}

function Toolbar({
  filters,
  onChange,
}: {
  filters: BidHistoryFilters;
  onChange: (next: BidHistoryFilters) => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const kinds: Kind[] = filters.kinds ? [...filters.kinds] : [];

  const toggleKind = (k: Kind) => {
    const set = new Set(kinds);
    if (set.has(k)) set.delete(k);
    else set.add(k);
    onChange({ ...filters, kinds: set.size > 0 ? Array.from(set) : undefined });
  };

  const updateNum = (key: 'sinceMs' | 'untilMs' | 'minAbsPriceDelta', v: string) => {
    const n = v ? Number(v) : undefined;
    onChange({ ...filters, [key]: n !== undefined && Number.isFinite(n) ? n : undefined });
  };

  const updateDate = (key: 'sinceMs' | 'untilMs', v: string) => {
    if (!v) {
      const next = { ...filters };
      delete next[key];
      onChange(next);
      return;
    }
    const d = new Date(v);
    onChange({
      ...filters,
      [key]: key === 'sinceMs' ? d.setHours(0, 0, 0, 0) : d.setHours(23, 59, 59, 999),
    });
  };

  const isoDateValue = (ms: number | undefined): string => {
    if (ms === undefined) return '';
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-3 flex flex-wrap items-end gap-x-4 gap-y-2 text-xs">
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] uppercase tracking-wider text-slate-500"><Trans>Action</Trans></label>
        <div className="flex gap-1">
          {(['CREATE_BID', 'EDIT_PRICE', 'EDIT_SPEED', 'CANCEL_BID'] as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => toggleKind(k)}
              className={`px-1.5 py-0.5 rounded border text-[11px] ${
                kinds.includes(k)
                  ? 'border-amber-700 text-amber-300 bg-amber-500/10'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              {labelForKindShort(k)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] uppercase tracking-wider text-slate-500"><Trans>Bid id contains</Trans></label>
        <input
          type="text"
          value={filters.orderIdContains ?? ''}
          onChange={(e) => onChange({ ...filters, orderIdContains: e.target.value || undefined })}
          placeholder="B866…"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="w-32 text-[11px] font-mono bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 focus:outline-none focus:border-amber-700"
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] uppercase tracking-wider text-slate-500"><Trans>From</Trans></label>
        <input
          type="date"
          value={isoDateValue(filters.sinceMs)}
          onChange={(e) => updateDate('sinceMs', e.target.value)}
          className="text-[11px] bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 focus:outline-none focus:border-amber-700"
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] uppercase tracking-wider text-slate-500"><Trans>To</Trans></label>
        <input
          type="date"
          value={isoDateValue(filters.untilMs)}
          onChange={(e) => updateDate('untilMs', e.target.value)}
          className="text-[11px] bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 focus:outline-none focus:border-amber-700"
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] uppercase tracking-wider text-slate-500"><Trans>Source</Trans></label>
        <select
          value={filters.source ?? ''}
          onChange={(e) =>
            onChange({
              ...filters,
              source: e.target.value === '' ? undefined : (e.target.value as 'AUTOPILOT' | 'OPERATOR'),
            })
          }
          className="text-[11px] bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 focus:outline-none focus:border-amber-700"
        >
          <option value="">{t`any`}</option>
          <option value="AUTOPILOT">{t`autopilot`}</option>
          <option value="OPERATOR">{t`manual`}</option>
        </select>
      </div>
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] uppercase tracking-wider text-slate-500"><Trans>|Δ price| ≥ (sat/PH/day)</Trans></label>
        <input
          type="number"
          min={0}
          step={100}
          value={filters.minAbsPriceDelta ?? ''}
          onChange={(e) => updateNum('minAbsPriceDelta', e.target.value)}
          placeholder="0"
          className="w-24 text-[11px] font-mono bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-slate-200 focus:outline-none focus:border-amber-700"
        />
      </div>
      <button
        type="button"
        onClick={() => onChange({})}
        className="text-[11px] text-slate-500 hover:text-amber-300 underline self-end"
      >
        <Trans>Clear all</Trans>
      </button>
    </div>
  );
}

function EventRow({
  event,
  fmt,
  denomination,
}: {
  event: BidHistoryFlatEvent;
  fmt: ReturnType<typeof useFormatters>;
  denomination: ReturnType<typeof useDenomination>;
}) {
  const { i18n } = useLingui();
  void i18n;
  const labels = useActionLabels();
  const oldPrice = event.old_price_sat_per_ph_day;
  const newPrice = event.new_price_sat_per_ph_day;
  const delta =
    oldPrice !== null && newPrice !== null ? newPrice - oldPrice : null;
  const orderShort = event.braiins_order_id
    ? `${event.braiins_order_id.slice(0, 6)}…${event.braiins_order_id.slice(-4)}`
    : '—';
  const speedText =
    event.speed_limit_ph !== null ? denomination.formatHashrate(event.speed_limit_ph) : '—';

  return (
    <tr className="border-t border-slate-800/70 hover:bg-slate-800/30 align-top">
      <td className="py-1 px-3 font-mono text-slate-300 whitespace-nowrap">
        {fmt.timestamp(event.occurred_at)}
      </td>
      <td className="py-1 px-3 font-mono text-slate-300 whitespace-nowrap">
        <span title={event.braiins_order_id ?? ''}>{orderShort}</span>
      </td>
      <td className="py-1 px-3 whitespace-nowrap">
        <ActionGlyph kind={event.kind} />
        <span className="ml-1.5 text-slate-200">{labels[event.kind]}</span>
      </td>
      <td className="py-1 px-3 text-right font-mono text-slate-400 whitespace-nowrap">
        {oldPrice !== null ? formatNumber(Math.round(oldPrice), {}) : '—'}
      </td>
      <td className="py-1 px-3 text-right font-mono text-slate-200 whitespace-nowrap">
        {newPrice !== null ? formatNumber(Math.round(newPrice), {}) : '—'}
      </td>
      <td className={`py-1 px-3 text-right font-mono whitespace-nowrap ${
        delta === null
          ? 'text-slate-500'
          : delta > 0
            ? 'text-red-300'
            : delta < 0
              ? 'text-emerald-300'
              : 'text-slate-500'
      }`}>
        {delta !== null
          ? `${delta >= 0 ? '+' : ''}${formatNumber(Math.round(delta), {})}`
          : '—'}
      </td>
      <td className="py-1 px-3 text-right font-mono text-slate-400 whitespace-nowrap">
        {event.fillable_at_event_sat_per_ph_day !== null
          ? formatNumber(Math.round(event.fillable_at_event_sat_per_ph_day), {})
          : '—'}
      </td>
      <td className="py-1 px-3 text-right font-mono text-slate-300 whitespace-nowrap">
        {speedText}
      </td>
      <td className="py-1 px-3 whitespace-nowrap">
        <span className={
          event.source === 'OPERATOR'
            ? 'text-amber-300 text-[10px] uppercase tracking-wider'
            : 'text-slate-500 text-[10px] uppercase tracking-wider'
        }>
          {event.source === 'OPERATOR' ? <Trans>manual</Trans> : <Trans>auto</Trans>}
        </span>
      </td>
    </tr>
  );
}

function useActionLabels(): Record<BidEventView['kind'], string> {
  return {
    CREATE_BID: t`create`,
    EDIT_PRICE: t`edit price`,
    EDIT_SPEED: t`edit speed`,
    CANCEL_BID: t`cancel`,
  };
}

function labelForKindShort(kind: Kind): string {
  switch (kind) {
    case 'CREATE_BID': return t`create`;
    case 'EDIT_PRICE': return t`price`;
    case 'EDIT_SPEED': return t`speed`;
    case 'CANCEL_BID': return t`cancel`;
  }
}

function ActionGlyph({ kind }: { kind: BidEventView['kind'] }) {
  const base = {
    width: 12,
    height: 12,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: 'inline-block align-middle',
  };
  if (kind === 'CREATE_BID') {
    return (
      <svg {...base} stroke="#34d399">
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12h8" />
        <path d="M12 8v8" />
      </svg>
    );
  }
  if (kind === 'EDIT_PRICE') {
    return (
      <svg width="12" height="12" viewBox="0 0 14 14" className="inline-block align-middle">
        <circle cx="7" cy="7" r="4.5" fill="#facc15" stroke="#0f172a" strokeWidth="1.5" />
      </svg>
    );
  }
  if (kind === 'EDIT_SPEED') {
    return (
      <svg {...base} stroke="#38bdf8">
        <path d="m12 14 4-4" />
        <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      </svg>
    );
  }
  return (
    <svg {...base} stroke="#f87171">
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  );
}
