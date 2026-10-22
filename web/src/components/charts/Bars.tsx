/* oxlint-disable jsx-a11y/prefer-tag-over-role -- an svg chart gets its name through role="img" */
import { Chart, truncate } from "./Chart";

const W = 320;
const ROW = 20;
const LABEL = 88;
const VALUE = 56;

/** One horizontal bar per row, longest first as given; each bar names its value. */
export function Bars({
  title,
  meaning,
  rows,
  format,
}: {
  title: string;
  meaning: string;
  rows: { label: string; value: number }[];
  format: (n: number) => string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  const room = W - LABEL - VALUE;
  return (
    <Chart title={title} meaning={meaning}>
      <svg
        role="img"
        aria-label={title}
        viewBox={`0 0 ${W} ${Math.max(rows.length, 1) * ROW}`}
        className="h-auto w-full"
      >
        {rows.map((row, i) => {
          const y = i * ROW;
          const w = max > 0 ? Math.max((row.value / max) * room, row.value > 0 ? 2 : 0) : 0;
          return (
            <g key={`${row.label}-${i}`} data-slot="row">
              <text x={0} y={y + 13} className="fill-foreground text-[10px]">
                {truncate(row.label, 14)}
              </text>
              <rect x={LABEL} y={y + 4} width={room} height={12} rx={1} className="fill-surface-tertiary" />
              {w > 0 ? (
                <rect x={LABEL} y={y + 4} width={w} height={12} rx={1} className="fill-chart-1">
                  <title>{`${row.label}: ${format(row.value)}`}</title>
                </rect>
              ) : null}
              <text x={W} y={y + 13} textAnchor="end" className="fill-muted font-mono text-[9px]">
                {format(row.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </Chart>
  );
}
