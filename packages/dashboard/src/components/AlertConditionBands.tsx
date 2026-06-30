/**
 * #316: timeline background bands for alerted condition spans, shared by
 * HashrateChart and PriceChart. Each condition class is tinted with its
 * own configurable color slot and only renders on the chart(s) it
 * targets (CONDITION_SPAN_CLASSES[].charts). A diagonal hatch fill plus
 * a dashed onset line at the span start, mirroring the #287 idle/pause
 * band visual language. The native <title> tooltip names the condition,
 * the source alert title, and the duration - matching the existing
 * untranslated band tooltips on these charts.
 */

import {
  conditionSpanClass,
  type AlertChartTarget,
} from '@hashrate-autopilot/shared';

import type { AlertConditionInterval } from '../lib/api';
import {
  darkenHex,
  getChartColor,
  parseOverrides,
  type ChartColorKey,
} from '../lib/chartColors';
import { formatDuration } from '../lib/format';

export function AlertConditionBands({
  intervals,
  target,
  xScale,
  dataMinX,
  dataMaxX,
  top,
  height,
  colorOverrides,
  idSuffix,
}: {
  intervals: ReadonlyArray<AlertConditionInterval>;
  target: AlertChartTarget;
  xScale: (x: number) => number;
  dataMinX: number;
  dataMaxX: number;
  top: number;
  height: number;
  /** Parsed chart_color_overrides (from parseOverrides). */
  colorOverrides: ReturnType<typeof parseOverrides>;
  /** Unique-per-chart suffix so the <pattern> ids don't collide. */
  idSuffix: string;
}) {
  const relevant = intervals.filter((iv) =>
    conditionSpanClass(iv.span.event_class)?.charts.includes(target),
  );
  if (relevant.length === 0) return null;

  // One <pattern> per distinct class present in the viewport.
  const classes = Array.from(
    new Map(
      relevant
        .map((iv) => conditionSpanClass(iv.span.event_class))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => [c.openClass, c]),
    ).values(),
  );

  return (
    <>
      <defs>
        {classes.map((c) => {
          const color = getChartColor(c.colorSlot as ChartColorKey, colorOverrides);
          return (
            <pattern
              key={c.openClass}
              id={`alertBand_${c.openClass}_${idSuffix}`}
              patternUnits="userSpaceOnUse"
              width="10"
              height="10"
              patternTransform="rotate(45)"
            >
              <rect width="10" height="10" fill={darkenHex(color, 0.45)} fillOpacity="0.22" />
              <line x1="0" y1="0" x2="0" y2="10" stroke={color} strokeWidth="1.5" strokeOpacity="0.5" />
            </pattern>
          );
        })}
      </defs>
      {relevant.map((iv, i) => {
        const cls = conditionSpanClass(iv.span.event_class);
        if (!cls) return null;
        const x0 = xScale(Math.max(dataMinX, iv.x0));
        const x1 = xScale(Math.min(dataMaxX, iv.x1));
        if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 <= x0) return null;
        const color = getChartColor(cls.colorSlot as ChartColorKey, colorOverrides);
        const clampedSpan = Math.min(dataMaxX, iv.x1) - Math.max(dataMinX, iv.x0);
        const ongoing = !Number.isFinite(iv.x1);
        return (
          <g key={`alert-band-${iv.span.open_id}-${i}`}>
            <rect
              x={x0}
              y={top}
              width={x1 - x0}
              height={height}
              fill={`url(#alertBand_${cls.openClass}_${idSuffix})`}
            >
              <title>
                {`${cls.label}: ${iv.span.title} (${formatDuration(clampedSpan)}${ongoing ? ', ongoing' : ''})`}
              </title>
            </rect>
            {/* Onset line at the span start so the moment it began reads
                clearly even when the band is narrow. */}
            <line
              x1={x0}
              y1={top}
              x2={x0}
              y2={top + height}
              stroke={color}
              strokeWidth="1.2"
              strokeOpacity="0.7"
              strokeDasharray="3 2"
              pointerEvents="none"
            />
          </g>
        );
      })}
    </>
  );
}
