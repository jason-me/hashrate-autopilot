import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type ChartRange,
  type ChartViewport,
  DEFAULT_CHART_RANGE,
  CHART_RANGE_SPECS,
  presetToViewport,
  viewportToNearestPreset,
} from '@braiins-hashrate/shared';

const STORAGE_KEY = 'hashrate-chart-range';
const MIN_DURATION_MS = 10 * 60_000; // 10 min
const MAX_DURATION_MS = 5 * 365 * 24 * 60 * 60_000; // 5 years
const SETTLE_DELAY_MS = 200;
const ZOOM_FACTOR = 1.15;

export interface ViewportState {
  since_ms: number;
  until_ms: number;
  activePreset: ChartRange | null;
}

export interface UseChartViewportReturn {
  viewport: ViewportState;
  settledViewport: ViewportState;
  setPreset: (range: ChartRange) => void;
  reset: () => void;
  handlers: {
    onWheel: (e: React.WheelEvent<SVGSVGElement>) => void;
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => void;
    onDoubleClick: () => void;
  };
  isDragging: boolean;
  dragOffsetPx: number;
}

function readStored(): ViewportState {
  if (typeof window === 'undefined') {
    return { ...presetToViewport(DEFAULT_CHART_RANGE), activePreset: DEFAULT_CHART_RANGE };
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw && (raw.startsWith('{') || raw === 'all')) {
    // Try JSON viewport first (new format)
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.since_ms != null && parsed.until_ms != null) {
          const preset = viewportToNearestPreset(parsed);
          return { since_ms: parsed.since_ms, until_ms: parsed.until_ms, activePreset: preset };
        }
      } catch { /* fall through */ }
    }
  }
  // Legacy: stored as a preset string like "24h"
  const preset = (['3h', '6h', '12h', '24h', '1w', '1m', '1y', 'all'] as ChartRange[]).includes(raw as ChartRange)
    ? (raw as ChartRange)
    : DEFAULT_CHART_RANGE;
  return { ...presetToViewport(preset), activePreset: preset };
}

function persist(state: ViewportState): void {
  if (typeof window === 'undefined') return;
  if (state.activePreset) {
    window.localStorage.setItem(STORAGE_KEY, state.activePreset);
  } else {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      since_ms: state.since_ms,
      until_ms: state.until_ms,
    }));
  }
}

function clampViewport(vp: ChartViewport): ChartViewport {
  const now = Date.now();
  let duration = vp.until_ms - vp.since_ms;
  if (duration < MIN_DURATION_MS) duration = MIN_DURATION_MS;
  if (duration > MAX_DURATION_MS) duration = MAX_DURATION_MS;
  let until = Math.min(vp.until_ms, now);
  let since = until - duration;
  if (since < 0) {
    since = 0;
    until = Math.min(duration, now);
  }
  return { since_ms: since, until_ms: until };
}

function quantize(ms: number, step: number): number {
  return Math.round(ms / step) * step;
}

export function useChartViewport(): UseChartViewportReturn {
  const [viewport, setViewport] = useState<ViewportState>(readStored);
  const [settledViewport, setSettledViewport] = useState<ViewportState>(viewport);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffsetPx, setDragOffsetPx] = useState(0);

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStart = useRef<{ clientX: number; viewport: ViewportState } | null>(null);

  const scheduleSettle = useCallback((vp: ViewportState) => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      const q: ViewportState = {
        since_ms: quantize(vp.since_ms, 5000),
        until_ms: quantize(vp.until_ms, 5000),
        activePreset: vp.activePreset,
      };
      setSettledViewport(q);
    }, SETTLE_DELAY_MS);
  }, []);

  const updateViewport = useCallback((vp: ViewportState) => {
    setViewport(vp);
    persist(vp);
    scheduleSettle(vp);
  }, [scheduleSettle]);

  const setPreset = useCallback((range: ChartRange) => {
    const vp: ViewportState = { ...presetToViewport(range), activePreset: range };
    setViewport(vp);
    setSettledViewport(vp);
    persist(vp);
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  const reset = useCallback(() => {
    setPreset(DEFAULT_CHART_RANGE);
  }, [setPreset]);

  // Auto-advance live-edge viewports
  useEffect(() => {
    if (viewport.activePreset === null) return;
    const spec = CHART_RANGE_SPECS[viewport.activePreset];
    if (spec.windowMs === null) return;
    const id = setInterval(() => {
      const now = Date.now();
      const vp: ViewportState = {
        since_ms: now - spec.windowMs!,
        until_ms: now,
        activePreset: viewport.activePreset,
      };
      setViewport(vp);
      setSettledViewport(vp);
    }, 60_000);
    return () => clearInterval(id);
  }, [viewport.activePreset]);

  const getSvgDataFraction = useCallback((e: React.MouseEvent<SVGSVGElement>): number => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const svgWidth = rect.width;
    const paddingLeft = 80;
    const paddingRight = 80;
    const leftFrac = paddingLeft / 880;
    const rightFrac = (880 - paddingRight) / 880;
    const pxLeft = svgWidth * leftFrac;
    const pxRight = svgWidth * rightFrac;
    return Math.max(0, Math.min(1, (clientX - pxLeft) / (pxRight - pxLeft)));
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const fraction = getSvgDataFraction(e);
    const duration = viewport.until_ms - viewport.since_ms;
    const factor = e.deltaY > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
    const newDuration = Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, duration * factor));
    const cursorTime = viewport.since_ms + fraction * duration;
    const raw: ChartViewport = {
      since_ms: cursorTime - fraction * newDuration,
      until_ms: cursorTime + (1 - fraction) * newDuration,
    };
    const clamped = clampViewport(raw);
    const preset = viewportToNearestPreset(clamped);
    updateViewport({ ...clamped, activePreset: preset });
  }, [viewport, getSvgDataFraction, updateViewport]);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { clientX: e.clientX, viewport };
    setIsDragging(true);
    setDragOffsetPx(0);
  }, [viewport]);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragStart.current) return;
    const deltaPx = e.clientX - dragStart.current.clientX;
    setDragOffsetPx(deltaPx);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragStart.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const deltaPx = e.clientX - dragStart.current.clientX;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const svgWidth = rect.width;
    const paddingLeft = 80;
    const paddingRight = 80;
    const leftFrac = paddingLeft / 880;
    const rightFrac = (880 - paddingRight) / 880;
    const dataWidthPx = svgWidth * (rightFrac - leftFrac);
    const startVp = dragStart.current.viewport;
    const duration = startVp.until_ms - startVp.since_ms;
    const deltaMs = -(deltaPx / dataWidthPx) * duration;
    const raw: ChartViewport = {
      since_ms: startVp.since_ms + deltaMs,
      until_ms: startVp.until_ms + deltaMs,
    };
    const clamped = clampViewport(raw);
    const preset = viewportToNearestPreset(clamped);
    dragStart.current = null;
    setIsDragging(false);
    setDragOffsetPx(0);
    updateViewport({ ...clamped, activePreset: preset });
  }, [updateViewport]);

  const onDoubleClick = useCallback(() => {
    reset();
  }, [reset]);

  return {
    viewport,
    settledViewport,
    setPreset,
    reset,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp, onDoubleClick },
    isDragging,
    dragOffsetPx,
  };
}
