import { Trans } from '@lingui/macro';
import { useLingui } from '@lingui/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

const UNACK_ONLY_STORAGE_KEY = 'braiins.alertsUnacknowledgedOnly';
// #121: cursor pagination page size. Server hard-cap is 1000; 50 is
// enough to fit on a typical screen without scrolling and gives the
// "Load older" button the time to feel useful.
const PAGE_SIZE = 50;

import {
  api,
  type AlertDeliveryStatus,
  type AlertRow,
} from '../lib/api';
import { formatAge, formatTimestamp } from '../lib/format';
import { useLocale } from '../lib/locale';

export function Alerts() {
  const qc = useQueryClient();
  const { i18n } = useLingui();
  void i18n;
  // Persist the filter checkbox so an operator-set preference
  // survives a page reload. Sibling pattern to Status.tsx's chart
  // range / right-axis preferences. localStorage is fine here -
  // each operator's browser has its own filter intent.
  const [unackOnly, setUnackOnly] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(UNACK_ONLY_STORAGE_KEY) === '1';
  });
  useEffect(() => {
    window.localStorage.setItem(UNACK_ONLY_STORAGE_KEY, unackOnly ? '1' : '0');
  }, [unackOnly]);

  // #121: cursor pagination. The head page (most-recent 50 rows)
  // refreshes on the same 30s cadence as before. Older pages are
  // appended one-at-a-time when the operator clicks "Load older",
  // and reset to empty when the filter toggle changes (otherwise
  // the operator would see filtered + unfiltered rows interleaved).
  const [olderPages, setOlderPages] = useState<
    Array<{ alerts: AlertRow[]; has_more: boolean }>
  >([]);

  // Reset older pages when the filter changes; the cursor referent
  // shifts with the filter set.
  useEffect(() => {
    setOlderPages([]);
  }, [unackOnly]);

  const headFilters: Parameters<typeof api.alertsList>[0] = { limit: PAGE_SIZE };
  if (unackOnly) headFilters.unacknowledged_only = true;

  const query = useQuery({
    queryKey: ['alerts', unackOnly],
    queryFn: () => api.alertsList(headFilters),
    refetchInterval: 30_000,
  });

  // Invalidate both the table query AND the nav-bar unread-count query
  // (Layout's `['alerts-head']`) so the red badge updates the instant
  // the operator clicks. Without the second invalidate the badge waits
  // up to 30s for its next poll - confusingly stale right after an ack.
  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ['alerts'] });
    qc.invalidateQueries({ queryKey: ['alerts-head'] });
  };

  const ack = useMutation({
    mutationFn: (id: number) => api.alertAcknowledge(id),
    onSuccess: invalidateAll,
  });

  const ackAll = useMutation({
    mutationFn: () => api.alertAcknowledgeAll(),
    onSuccess: invalidateAll,
  });

  // Concatenate head + older pages, dedupe on id in case a new row
  // arrived during pagination and bumped a row from the head into a
  // later page (rare but possible when `unackOnly` is false).
  const alerts = useMemo(() => {
    const seen = new Set<number>();
    const out: AlertRow[] = [];
    const headRows = query.data?.alerts ?? [];
    for (const row of headRows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        out.push(row);
      }
    }
    for (const page of olderPages) {
      for (const row of page.alerts) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          out.push(row);
        }
      }
    }
    return out;
  }, [query.data, olderPages]);

  // has_more comes from the most recently loaded page (the bottom of
  // the visible list). Empty older-pages array → use the head's flag.
  const hasMore =
    olderPages.length > 0
      ? olderPages[olderPages.length - 1]!.has_more
      : (query.data?.has_more ?? false);

  const totalCount = query.data?.total_count ?? alerts.length;
  const unackedCount = useMemo(
    () => alerts.filter((a) => a.acknowledged_at_ms === null).length,
    [alerts],
  );

  const loadOlder = useMutation({
    mutationFn: async () => {
      const lastRow = alerts[alerts.length - 1];
      if (!lastRow) throw new Error('no rows to paginate from');
      return api.alertsList({
        ...headFilters,
        before_created_at_ms: lastRow.created_at,
      });
    },
    onSuccess: (resp) =>
      setOlderPages((prev) => [...prev, { alerts: resp.alerts, has_more: resp.has_more }]),
  });

  return (
    <div className="space-y-4">
      <header className="flex items-baseline gap-3">
        <h1 className="text-2xl text-slate-100">
          <Trans>Alerts</Trans>
        </h1>
        <p className="text-xs text-slate-500">
          <Trans>
            Audit trail for every notification the daemon recorded - sent, failed,
            muted, snoozed, or given-up. Configure the Telegram destination on
            Config → Notifications.
          </Trans>
        </p>
      </header>

      <section className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={unackOnly}
            onChange={(e) => setUnackOnly(e.target.checked)}
            className="accent-amber-400 h-3.5 w-3.5"
          />
          <Trans>unacknowledged only</Trans>
        </label>
        <button
          type="button"
          onClick={() => ackAll.mutate()}
          disabled={ackAll.isPending || unackedCount === 0}
          className="px-2 py-1 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {ackAll.isPending ? (
            <Trans>marking…</Trans>
          ) : (
            <Trans>mark all as seen ({unackedCount})</Trans>
          )}
        </button>
        {alerts.length > 0 && (
          <span className="ml-auto text-xs text-slate-500">
            <Trans>
              showing {alerts.length} of {totalCount}
            </Trans>
          </span>
        )}
      </section>

      {query.isPending && (
        <div className="text-sm text-slate-500">
          <Trans>loading…</Trans>
        </div>
      )}

      {query.isError && (
        <div className="text-sm text-red-400">{(query.error as Error).message}</div>
      )}

      {query.data && alerts.length === 0 && (
        <div className="text-sm text-slate-500 italic py-6 text-center bg-slate-900 border border-slate-800 rounded">
          <Trans>no alerts matching the filter.</Trans>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-800/40 text-slate-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-3 py-2 font-normal">
                  <Trans>when</Trans>
                </th>
                <th className="text-left px-3 py-2 font-normal">
                  <Trans>title</Trans>
                </th>
                <th className="text-left px-3 py-2 font-normal">
                  <Trans>delivery</Trans>
                </th>
                <th className="text-right px-3 py-2 font-normal">
                  <Trans>actions</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((row) => (
                <AlertRow
                  key={row.id}
                  row={row}
                  onAcknowledge={() => ack.mutate(row.id)}
                />
              )) /* AlertRow uses useLocale internally for the absolute timestamp formatting. */}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => loadOlder.mutate()}
            disabled={loadOlder.isPending}
            className="px-3 py-1.5 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800 disabled:opacity-40"
          >
            {loadOlder.isPending ? <Trans>loading…</Trans> : <Trans>load older</Trans>}
          </button>
        </div>
      )}
    </div>
  );
}

function AlertRow({
  row,
  onAcknowledge,
}: {
  row: AlertRow;
  onAcknowledge: () => void;
}) {
  // Mirror the Status page's bids-card timestamp pattern: absolute
  // datetime in the operator's regional format on top, relative age
  // muted underneath. Operator wanted both visible at a glance.
  const { intlLocale } = useLocale();
  return (
    <tr className="border-t border-slate-800 align-top">
      <td className="px-3 py-2 text-xs whitespace-nowrap">
        <div className="text-slate-300">{formatTimestamp(row.created_at, intlLocale)}</div>
        <div className="text-slate-500 text-[10px] mt-0.5">{formatAge(row.created_at)}</div>
      </td>
      <td className="px-3 py-2">
        <div className="text-slate-200">{row.title}</div>
        <div className="text-xs text-slate-500 mt-0.5 break-words max-w-xl">{row.body}</div>
      </td>
      <td className="px-3 py-2">
        <DeliveryBadge status={row.delivery_status} attempts={row.delivery_attempts} />
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        {row.acknowledged_at_ms === null ? (
          <button
            onClick={onAcknowledge}
            className="px-2 py-1 text-xs text-slate-300 border border-slate-700 rounded hover:bg-slate-800"
          >
            <Trans>mark as seen</Trans>
          </button>
        ) : (
          <span className="text-[10px] text-slate-500">
            <Trans>acknowledged {formatAge(row.acknowledged_at_ms)}</Trans>
          </span>
        )}
      </td>
    </tr>
  );
}

function DeliveryBadge({
  status,
  attempts,
}: {
  status: AlertDeliveryStatus;
  attempts: number;
}) {
  const cls =
    status === 'sent'
      ? 'text-emerald-300'
      : status === 'failed' || status === 'gave_up'
        ? 'text-red-400'
        : status === 'muted' || status === 'snoozed'
          ? 'text-slate-500'
          : 'text-amber-300';
  return (
    <span className={'text-xs font-mono ' + cls}>
      {status}
      {attempts > 0 && ` · ${attempts}`}
    </span>
  );
}
