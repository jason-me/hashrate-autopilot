/**
 * #257: synced crosshair for the stacked Status charts.
 *
 * One shared hover/pin position (a data-space timestamp) drives a
 * vertical marker line through both HashrateChart and PriceChart,
 * each rendering its own per-series value readout at that tick. The
 * charts share an x-axis layout by design, so a single `tickAt`
 * lands on the same pixel column in both.
 *
 * Interaction model (operator-interviewed, see issue #257):
 *  - Mouse hover shows a transient crosshair; click pins it at that
 *    tick (re-click re-pins). Esc or a click outside the charts
 *    dismisses a pinned crosshair.
 *  - Touch: a quick drag still pans (unchanged viewport gesture); a
 *    ~300 ms long-press engages scrub mode where the finger drives
 *    the crosshair instead of the pan, and lifting the finger pins.
 *    A plain tap pins directly.
 *  - Marker icons (pool blocks, retargets, IP changes, ...) win on
 *    direct hover: their click handlers stopPropagation so a marker
 *    click never double-fires a crosshair pin, and the host chart
 *    suppresses the readout box while a marker hover-tooltip is open.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

import { useFormatters } from './locale';
import { formatAgeMinutes, formatTimestampUtc } from './format';
import { clientXToTickAt, nearestTickIndex, type CrosshairGeometry } from './chartCrosshairMath';

// Re-exported so the charts can import everything crosshair-related
// from this one module.
export { clientXToTickAt, nearestTickIndex, type CrosshairGeometry };

const LONG_PRESS_MS = 300;
/** Movement past this cancels a pending long-press (it's a pan). Matches
 *  useChartViewport's DRAG_THRESHOLD_PX so the two gestures agree on
 *  what counts as "moved". */
const MOVE_TOLERANCE_PX = 5;

export interface CrosshairState {
  /** Snapped data-space timestamp (a real tick_at from the series). */
  tickAt: number;
  /** Chart id the pointer is (or was, when pinned) over. */
  source: string;
  /** Viewport-absolute pointer coords at the last move/pin - the
   *  source chart anchors its readout box here, like the existing
   *  marker tooltips do. */
  clientX: number;
  clientY: number;
  pinned: boolean;
}

export interface SharedCrosshair {
  state: CrosshairState | null;
  move: (source: string, tickAt: number, clientX: number, clientY: number) => void;
  leave: (source: string) => void;
  pin: (source: string, tickAt: number, clientX: number, clientY: number) => void;
  clear: () => void;
}

/**
 * Page-level hook: owns the one crosshair position both charts
 * share. Lives in Status.tsx next to useChartViewport (same
 * "shared interaction state above the two charts" pattern).
 */
export function useSharedCrosshair(): SharedCrosshair {
  const [state, setState] = useState<CrosshairState | null>(null);

  const move = useCallback((source: string, tickAt: number, clientX: number, clientY: number) => {
    setState((prev) => {
      if (prev?.pinned) return prev;
      // Snap-gated update: pointer moves within the same snapped tick
      // don't produce a new state object. Both (memo'd) charts
      // re-render per crosshair change, so updating only when the
      // tick or source chart changes keeps hover cheap - the marker
      // line can't move between ticks anyway.
      if (prev && prev.tickAt === tickAt && prev.source === source) return prev;
      return { tickAt, source, clientX, clientY, pinned: false };
    });
  }, []);

  const leave = useCallback((source: string) => {
    setState((prev) => {
      if (!prev || prev.pinned) return prev;
      return prev.source === source ? null : prev;
    });
  }, []);

  const pin = useCallback((source: string, tickAt: number, clientX: number, clientY: number) => {
    setState({ tickAt, source, clientX, clientY, pinned: true });
  }, []);

  const clear = useCallback(() => setState(null), []);

  // Pinned dismissal: Esc anywhere, or a pointerdown outside any
  // element marked data-chart-crosshair (the two chart cards and the
  // readout boxes carry the attribute).
  const pinned = state?.pinned === true;
  useEffect(() => {
    if (!pinned) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState(null);
    };
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest('[data-chart-crosshair]')) return;
      setState(null);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onDocPointerDown);
    };
  }, [pinned]);

  return useMemo(
    () => ({ state, move, leave, pin, clear }),
    [state, move, leave, pin, clear],
  );
}

interface ViewportHandlers {
  onPointerDown: React.PointerEventHandler<SVGSVGElement>;
  onPointerMove: React.PointerEventHandler<SVGSVGElement>;
  onPointerUp: React.PointerEventHandler<SVGSVGElement>;
  onDoubleClick: () => void;
}

export interface CrosshairSvgHandlers {
  onPointerDown: React.PointerEventHandler<SVGSVGElement>;
  onPointerMove: React.PointerEventHandler<SVGSVGElement>;
  onPointerUp: React.PointerEventHandler<SVGSVGElement>;
  onPointerLeave: React.PointerEventHandler<SVGSVGElement>;
  onClick: React.MouseEventHandler<SVGSVGElement>;
  onDoubleClick: () => void;
}

/**
 * Per-chart pointer composition: wraps the chart's viewport pan/zoom
 * handlers with crosshair hover, click-to-pin, and the touch
 * long-press scrub. The chart spreads the returned handlers onto its
 * <svg> instead of the raw viewportHandlers.
 */
export function useCrosshairPointer(opts: {
  chartId: string;
  crosshair: SharedCrosshair | undefined;
  viewportHandlers: ViewportHandlers | undefined;
  /** clientX -> snapped tick, with the chart's current geometry.
   *  Null when the pointer is outside the data region. */
  clientToTick: (svg: SVGSVGElement, clientX: number) => number | null;
}): CrosshairSvgHandlers {
  const { chartId, crosshair, viewportHandlers, clientToTick } = opts;

  const downRef = useRef<{ x: number; y: number; pointerType: string } | null>(null);
  const movedRef = useRef(false);
  const scrubRef = useRef(false);
  const suppressClickRef = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest callbacks in refs so the returned handlers stay
  // referentially stable across renders (the charts are memo'd).
  const crosshairRef = useRef(crosshair);
  crosshairRef.current = crosshair;
  const viewportRef = useRef(viewportHandlers);
  viewportRef.current = viewportHandlers;
  const clientToTickRef = useRef(clientToTick);
  clientToTickRef.current = clientToTick;

  useEffect(() => () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const onPointerDown = useCallback<React.PointerEventHandler<SVGSVGElement>>((e) => {
    viewportRef.current?.onPointerDown(e);
    downRef.current = { x: e.clientX, y: e.clientY, pointerType: e.pointerType };
    movedRef.current = false;
    scrubRef.current = false;
    if (e.pointerType === 'touch') {
      const svg = e.currentTarget;
      const startX = e.clientX;
      const startY = e.clientY;
      clearLongPress();
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null;
        if (movedRef.current) return;
        // Engage scrub: from here the finger drives the crosshair and
        // the viewport pan never captures (we stop forwarding moves).
        scrubRef.current = true;
        const tick = clientToTickRef.current(svg, startX);
        if (tick !== null) crosshairRef.current?.move(chartId, tick, startX, startY);
      }, LONG_PRESS_MS);
    }
  }, [chartId, clearLongPress]);

  const onPointerMove = useCallback<React.PointerEventHandler<SVGSVGElement>>((e) => {
    const down = downRef.current;
    if (down) {
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!movedRef.current && Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) {
        movedRef.current = true;
        // Movement before the long-press fires = pan intent.
        if (!scrubRef.current) clearLongPress();
      }
    }

    if (scrubRef.current) {
      // Long-press scrub: crosshair follows the finger; pan stays out.
      const tick = clientToTickRef.current(e.currentTarget, e.clientX);
      if (tick !== null) crosshairRef.current?.move(chartId, tick, e.clientX, e.clientY);
      return;
    }

    viewportRef.current?.onPointerMove(e);

    if (down) {
      // Button/finger held without scrub = pan (or about to be).
      // Hide the transient crosshair so it doesn't fight the drag.
      if (movedRef.current) crosshairRef.current?.leave(chartId);
      return;
    }
    // Plain hover (no buttons): drive the crosshair.
    const tick = clientToTickRef.current(e.currentTarget, e.clientX);
    if (tick === null) crosshairRef.current?.leave(chartId);
    else crosshairRef.current?.move(chartId, tick, e.clientX, e.clientY);
  }, [chartId, clearLongPress]);

  const onPointerUp = useCallback<React.PointerEventHandler<SVGSVGElement>>((e) => {
    clearLongPress();
    const wasScrub = scrubRef.current;
    scrubRef.current = false;
    downRef.current = null;
    if (wasScrub) {
      // Lift after scrub = pin where the finger stopped. Swallow the
      // synthetic click some browsers fire after a long-press.
      suppressClickRef.current = true;
      const tick = clientToTickRef.current(e.currentTarget, e.clientX);
      if (tick !== null) crosshairRef.current?.pin(chartId, tick, e.clientX, e.clientY);
    }
    viewportRef.current?.onPointerUp(e);
  }, [chartId, clearLongPress]);

  const onPointerLeave = useCallback<React.PointerEventHandler<SVGSVGElement>>(() => {
    clearLongPress();
    if (!scrubRef.current) crosshairRef.current?.leave(chartId);
  }, [chartId, clearLongPress]);

  const onClick = useCallback<React.MouseEventHandler<SVGSVGElement>>((e) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    // A drag that ended on this chart still fires a click; don't pin.
    if (movedRef.current) return;
    const tick = clientToTickRef.current(e.currentTarget, e.clientX);
    if (tick === null) return;
    crosshairRef.current?.pin(chartId, tick, e.clientX, e.clientY);
  }, [chartId]);

  const onDoubleClick = useCallback(() => {
    viewportRef.current?.onDoubleClick();
  }, []);

  return useMemo(
    () => ({ onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onClick, onDoubleClick }),
    [onPointerDown, onPointerMove, onPointerUp, onPointerLeave, onClick, onDoubleClick],
  );
}

export interface CrosshairReadoutRow {
  color: string;
  label: string;
  value: string;
  /** Render the swatch as a dashed line (reference series). */
  dashed?: boolean;
}

/**
 * The floating per-chart value readout. Rendered by each chart (both
 * show their own values for the shared tick). On the chart the
 * pointer is over, the box trails the cursor like the existing
 * marker tooltips; on the other chart it anchors beside the marker
 * line inside that chart's plot area.
 */
export function CrosshairReadout({
  chartId,
  state,
  svgEl,
  /** Crosshair x position as a fraction of the SVG viewBox width -
   *  used to anchor the box on the non-source chart. */
  lineXFrac,
  rows,
  onClose,
}: {
  chartId: string;
  state: CrosshairState;
  svgEl: SVGSVGElement | null;
  lineXFrac: number;
  rows: ReadonlyArray<CrosshairReadoutRow>;
  onClose: () => void;
}) {
  const { i18n } = useLingui();
  void i18n;
  const fmt = useFormatters();
  const ref = useRef<HTMLDivElement | null>(null);
  const isSource = state.source === chartId;
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: state.clientX + 12,
    top: state.clientY + 12,
    ready: false,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let anchorX: number;
    let anchorY: number;
    if (isSource) {
      anchorX = state.clientX;
      anchorY = state.clientY;
    } else if (svgEl) {
      const svgRect = svgEl.getBoundingClientRect();
      anchorX = svgRect.left + lineXFrac * svgRect.width;
      anchorY = svgRect.top + svgRect.height * 0.25;
    } else {
      anchorX = state.clientX;
      anchorY = state.clientY;
    }
    let left = anchorX + 12;
    let top = anchorY + 12;
    if (left + rect.width > window.innerWidth - margin) left = anchorX - rect.width - 12;
    if (top + rect.height > window.innerHeight - margin) top = anchorY - rect.height - 12;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    setPos({ left, top, ready: true });
  }, [state.clientX, state.clientY, state.tickAt, isSource, svgEl, lineXFrac, rows.length]);

  if (rows.length === 0) return null;

  return (
    <div
      ref={ref}
      data-chart-crosshair
      className={`fixed z-50 bg-slate-950 border rounded-lg shadow-lg p-3 text-xs whitespace-nowrap ${state.pinned ? 'border-slate-500 pointer-events-auto' : 'border-slate-700 pointer-events-none'} ${pos.ready ? '' : 'invisible'}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-slate-300">
          {fmt.timestamp(state.tickAt)}
          <span className="text-slate-500 ml-2">· {formatAgeMinutes(state.tickAt)}</span>
        </span>
        {state.pinned && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t`close`}
            className="text-slate-500 hover:text-slate-200 leading-none text-base -mt-0.5 -mr-0.5"
          >
            ×
          </button>
        )}
      </div>
      <div className="text-slate-500 text-[10px]">{formatTimestampUtc(state.tickAt)}</div>
      <div className="mt-2 space-y-0.5">
        {rows.map((row) => (
          <div key={row.label} className="flex justify-between items-center gap-4">
            <span className="flex items-center gap-1.5 text-slate-400">
              <svg width="14" height="6" aria-hidden="true">
                <line
                  x1="0"
                  y1="3"
                  x2="14"
                  y2="3"
                  stroke={row.color}
                  strokeWidth="2"
                  strokeDasharray={row.dashed ? '3 2' : undefined}
                />
              </svg>
              {row.label}
            </span>
            <span className="font-mono tabular-nums text-slate-200">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
