/**
 * #320: export the Timeline to a formatted XLSX. Two pieces:
 *   - `fetchAllBidEvents` pages the bid-history endpoint to completion
 *     within the active filters (the feed is otherwise 100/page).
 *   - `buildTimelineWorkbookBlob` lazy-loads exceljs (kept out of the
 *     main bundle via dynamic import) and writes a formatted sheet.
 * The caller (History) merges bid events with the extra rows already
 * held by their queries, applies the date range + toggles, and hands a
 * flat, newest-first row list here.
 */
import { api, type BidHistoryFilters, type BidHistoryFlatEvent } from './api';

/** One flat spreadsheet row. Bid-event columns are null for other kinds. */
export interface TimelineExportRow {
  whenUtc: string;
  whenLocal: string;
  type: string;
  bid: string | null;
  fillable: number | null;
  priceBefore: number | null;
  priceAfter: number | null;
  deltaPrice: number | null;
  speed: number | null;
  reason: string;
}

/** Hard ceiling so an unbounded range can't page forever. */
export const EXPORT_MAX_BID_ROWS = 5000;

/**
 * Page `/api/bid-history-events` to completion under the active filters.
 * Returns the events plus whether the ceiling truncated the pull (the
 * caller surfaces that so a silent cap can't masquerade as "everything").
 */
export async function fetchAllBidEvents(
  filters: BidHistoryFilters,
): Promise<{ events: BidHistoryFlatEvent[]; truncated: boolean }> {
  const events: BidHistoryFlatEvent[] = [];
  let cursor: number | undefined = undefined;
  let truncated = false;
  // Bounded loop: at 100/page the ceiling is 50 iterations.
  for (let i = 0; i < Math.ceil(EXPORT_MAX_BID_ROWS / 100) + 1; i += 1) {
    const page = await api.bidHistoryFlatEvents(filters, cursor, 100);
    events.push(...page.events);
    if (events.length >= EXPORT_MAX_BID_ROWS) {
      truncated = page.next_cursor_id !== null;
      break;
    }
    if (page.next_cursor_id === null) break;
    cursor = page.next_cursor_id;
  }
  return { events: events.slice(0, EXPORT_MAX_BID_ROWS), truncated };
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

/**
 * Build a formatted XLSX Blob from the flat rows. exceljs is imported
 * dynamically so it only loads when the operator actually exports.
 */
export async function buildTimelineWorkbookBlob(
  rows: readonly TimelineExportRow[],
  localTimestamp: (ms: number) => string,
): Promise<Blob> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Hashrate Autopilot';
  const ws = wb.addWorksheet('Timeline', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = [
    { header: 'When (UTC)', key: 'whenUtc', width: 21 },
    { header: 'When (local)', key: 'whenLocal', width: 21 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Bid', key: 'bid', width: 22 },
    { header: 'Fillable (sat/PH/day)', key: 'fillable', width: 18 },
    { header: 'Price before', key: 'priceBefore', width: 13 },
    { header: 'Price after', key: 'priceAfter', width: 13 },
    { header: 'Δ price', key: 'deltaPrice', width: 10 },
    { header: 'Speed (PH/s)', key: 'speed', width: 12 },
    { header: 'Reason', key: 'reason', width: 70 },
  ];
  for (const r of rows) ws.addRow(r);

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FF0F172A' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFACC15' } };
  header.alignment = { vertical: 'middle' };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  // Right-align + integer-format the numeric columns.
  for (const key of ['fillable', 'priceBefore', 'priceAfter', 'deltaPrice', 'speed']) {
    const col = ws.getColumn(key);
    col.numFmt = '#,##0';
    col.alignment = { horizontal: 'right' };
  }
  // Header alignment overrides the column alignment set above.
  header.eachCell((cell) => {
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
  });
  void localTimestamp; // (rows already carry both timestamp strings)
  void isoUtc;

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/** Trigger a browser download of a Blob under `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export { isoUtc };
