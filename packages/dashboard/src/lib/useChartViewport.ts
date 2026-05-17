import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type ChartRange,
  CHART_RANGES,
  type ChartViewport,
  DEFAULT_CHART_RANGE,
  CHART_RANGE_SPECS,
  presetToViewport,
  viewportToNearestPreset,
} from '@braiins-hashrate/shared';

const STORAGE_KEY = 'hashrate-chart-range';
const MIN_DURATION_MS = 10 * 60_000;
const MAX_DURATION_MS = 5 * 365 * 24 * 60 * 60_000;
const SETTLE_DELAY_MS = 200;
const ZOOM_FACTOR = 1.15;
const DRAG_THRESHOLD_PX = 5;
const LIVE_EDGE_TOLERANCE_MS = 120_000;
const SVG_VIEWBOX_WIDTH = 880;

export interface ViewportState {
  since_ms: number;
  until_ms: number;
  activePreset: ChartRange | null;
  liveEdge: boolean;
}

export interface UseChartViewportReturn {
  viewport: ViewportState;
  settledViewport: ViewportState;
  setPreset: (range: ChartRange) => void;
  goLive: () => void;
  reset: () => void;
  handlers: {
    onWheel: (e: React.WheelEvent<SVGSVGElement>) => void;
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => void;
    onDoubleClick: () => void;
  };
  isDragging: boolean;
  isLiveEdge: boolean;
}

function readStored(): ViewportState {
  if (typeof window === 'undefined') {
    return { ...presetToViewport(DEFAULT_CHART_RANGE), activePreset: DEFAULT_CHART_RANGE, liveEdge: true };
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const preset = (['3h', '6h', '12h', '24h', '1w', '1m', '1y', 'all'] as ChartRange[]).includes(raw as ChartRange)
    ? (raw as ChartRange)
    : DEFAULT_CHART_RANGE;
  return { ...presetToViewport(preset), activePreset: preset, liveEdge: true };
}

function persist(state: ViewportState): void {
  if (typeof window === 'undefined') return;
  if (state.activePreset) {
    window.localStorage.setItem(STORAGE_KEY, state.activePreset);
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

function isAtLiveEdge(vp: ChartViewport): boolean {
  return Math.abs(vp.until_ms - Date.now()) < LIVE_EDGE_TOLERANCE_MS;
}

interface DragState {
  clientX: number;
  viewport: ViewportState;
  pointerId: number;
  captured: boolean;
  dataWidthPx: number;
}

export function useChartViewport(): UseChartViewportReturn {
  const [viewport, setViewport] = useState<ViewportState>(readStored);
  const [settledViewport, setSettledViewport] = useState<ViewportState>(viewport);
  const [isDragging, setIsDragging] = useState(false);

  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStart = useRef<DragState | null>(null);

  const scheduleSettle = useCallback((vp: ViewportState) => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      const q: ViewportState = {
        since_ms: quantize(vp.since_ms, 5000),
        until_ms: quantize(vp.until_ms, 5000),
        activePreset: vp.activePreset,
        liveEdge: vp.liveEdge,
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
    const vp: ViewportState = { ...presetToViewport(range), activePreset: range, liveEdge: true };
    setViewport(vp);
    setSettledViewport(vp);
    persist(vp);
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  const goLive = useCallback(() => {
    const preset = viewport.activePreset ?? DEFAULT_CHART_RANGE;
    setPreset(preset);
  }, [viewport.activePreset, setPreset]);

  const reset = useCallback(() => {
    setPreset(DEFAULT_CHART_RANGE);
  }, [setPreset]);

  useEffect(() => {
    if (!viewport.liveEdge || viewport.activePreset === null) return;
    const spec = CHART_RANGE_SPECS[viewport.activePreset];
    if (spec.windowMs === null) return;
    const id = setInterval(() => {
      const now = Date.now();
      const vp: ViewportState = {
        since_ms: now - spec.windowMs!,
        until_ms: now,
        activePreset: viewport.activePreset,
        liveEdge: true,
      };
      setViewport(vp);
      setSettledViewport(vp);
    }, 60_000);
    return () => clearInterval(id);
  }, [viewport.activePreset, viewport.liveEdge]);

  const getSvgDataFraction = useCallback((e: React.MouseEvent<SVGSVGElement>): number => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const svgWidth = rect.width;
    const paddingLeft = 80;
    const paddingRight = 80;
    const leftFrac = paddingLeft / SVG_VIEWBOX_WIDTH;
    const rightFrac = (SVG_VIEWBOX_WIDTH - paddingRight) / SVG_VIEWBOX_WIDTH;
    const pxLeft = svgWidth * leftFrac;
    const pxRight = svgWidth * rightFrac;
    return Math.max(0, Math.min(1, (clientX - pxLeft) / (pxRight - pxLeft)));
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const fraction = getSvgDataFraction(e);
    const duration = viewport.until_ms - viewport.since_ms;
    const factor = e.deltaY > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
    let newDuration = Math.max(MIN_DURATION_MS, Math.min(MAX_DURATION_MS, duration * factor));
    const halfStep = Math.sqrt(ZOOM_FACTOR);
    let snappedPreset: ChartRange | null = null;
    for (const key of CHART_RANGES) {
      const w = CHART_RANGE_SPECS[key].windowMs;
      if (w !== null && newDuration > w / halfStep && newDuration < w * halfStep) {
        newDuration = w;
        snappedPreset = key;
        break;
      }
    }
    const cursorTime = viewport.since_ms + fraction * duration;
    const raw: ChartViewport = {
      since_ms: cursorTime - fraction * newDuration,
      until_ms: cursorTime + (1 - fraction) * newDuration,
    };
    const clamped = clampViewport(raw);
    const preset = snappedPreset ?? viewportToNearestPreset(clamped);
    const live = isAtLiveEdge(clamped);
    updateViewport({ ...clamped, activePreset: preset, liveEdge: live });
  }, [viewport, getSvgDataFraction, updateViewport]);

  const computeDataWidthPx = useCallback((svg: SVGSVGElement): number => {
    const rect = svg.getBoundingClientRect();
    const svgWidth = rect.width;
    const paddingLeft = 80;
    const paddingRight = 80;
    const leftFrac = paddingLeft / SVG_VIEWBOX_WIDTH;
    const rightFrac = (SVG_VIEWBOX_WIDTH - paddingRight) / SVG_VIEWBOX_WIDTH;
    return svgWidth * (rightFrac - leftFrac);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    dragStart.current = {
      clientX: e.clientX,
      viewport,
      pointerId: e.pointerId,
      captured: false,
      dataWidthPx: computeDataWidthPx(e.currentTarget),
    };
  }, [viewport, computeDataWidthPx]);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragStart.current) return;
    const deltaPx = e.clientX - dragStart.current.clientX;
    if (!dragStart.current.captured && Math.abs(deltaPx) > DRAG_THRESHOLD_PX) {
      e.currentTarget.setPointerCapture(dragStart.current.pointerId);
      dragStart.current.captured = true;
      setIsDragging(true);
    }
    if (dragStart.current.captured) {
      const startVp = dragStart.current.viewport;
      const duration = startVp.until_ms - startVp.since_ms;
      const deltaMs = -(deltaPx / dragStart.current.dataWidthPx) * duration;
      const raw: ChartViewport = {
        since_ms: startVp.since_ms + deltaMs,
        until_ms: startVp.until_ms + deltaMs,
      };
      const clamped = clampViewport(raw);
      setViewport({ ...clamped, activePreset: startVp.activePreset, liveEdge: false });
    }
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragStart.current) return;
    const wasDrag = dragStart.current.captured;
    if (wasDrag) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      const startVp = dragStart.current.viewport;
      const live = isAtLiveEdge(viewport);
      const vp: ViewportState = { ...viewport, activePreset: startVp.activePreset, liveEdge: live };
      updateViewport(vp);
    }
    dragStart.current = null;
    setIsDragging(false);
  }, [viewport, updateViewport]);

  const onDoubleClick = useCallback(() => {
    goLive();
  }, [goLive]);

  return {
    viewport,
    settledViewport,
    setPreset,
    goLive,
    reset,
    handlers: { onWheel, onPointerDown, onPointerMove, onPointerUp, onDoubleClick },
    isDragging,
    isLiveEdge: viewport.liveEdge,
  };
}
