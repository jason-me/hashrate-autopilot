// #250: shared SVG marker layer for public-IP change events, drawn on
// both the hashrate and price charts. Each event is a vertical dashed
// tick plus a Lucide `router` glyph above the plot, with a native
// hover tooltip showing old -> new IP and the time. Always rendered
// (IP changes are rare and high-signal); not gated by the right-axis
// selector.
//
// Must be used INSIDE an <svg>. The caller passes its own x-scale and
// the plot's top / bottom y so this component stays agnostic of each
// chart's padding constants.

import { t } from '@lingui/core/macro';

export interface IpChangeMarkerEvent {
  readonly id: number;
  readonly occurred_at: number;
  readonly old_ip: string | null;
  readonly new_ip: string;
}

const COLOR = '#38bdf8'; // sky-400: distinct from retarget purple / block gold

export function IpChangeMarkers({
  events,
  xScale,
  dataMinX,
  dataMaxX,
  topY,
  bottomY,
}: {
  events: ReadonlyArray<IpChangeMarkerEvent>;
  xScale: (ms: number) => number;
  dataMinX: number;
  dataMaxX: number;
  /** y of the plot top (icon sits just above this). */
  topY: number;
  /** y of the plot bottom (tick line ends here). */
  bottomY: number;
}) {
  return (
    <>
      {events
        .filter((e) => e.occurred_at >= dataMinX && e.occurred_at <= dataMaxX)
        .map((e) => {
          const x = xScale(e.occurred_at);
          const when = new Date(e.occurred_at).toLocaleString();
          const arrow = e.old_ip ? `${e.old_ip} -> ${e.new_ip}` : e.new_ip;
          const label = `${t`IP changed`}: ${arrow}\n${when}`;
          return (
            <g key={`ipc-${e.id}`} style={{ cursor: 'help' }}>
              <title>{label}</title>
              <line
                x1={x}
                x2={x}
                y1={topY + 8}
                y2={bottomY}
                stroke={COLOR}
                strokeWidth="1"
                strokeDasharray="2 3"
                opacity="0.4"
                pointerEvents="none"
              />
              {/* transparent hit area so the native <title> tooltip fires */}
              <rect x={x - 9} y={topY - 13} width={18} height={18} fill="transparent" />
              <svg
                x={x - 7}
                y={topY - 11}
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke={COLOR}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.9"
              >
                <rect width="20" height="8" x="2" y="14" rx="2" />
                <path d="M6.01 18H6" />
                <path d="M10.01 18H10" />
                <path d="M15 10v4" />
                <path d="M17.84 7.17a4 4 0 0 0-5.66 0" />
                <path d="M20.66 4.34a8 8 0 0 0-11.31 0" />
              </svg>
            </g>
          );
        })}
    </>
  );
}
