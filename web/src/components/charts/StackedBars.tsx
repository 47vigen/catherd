/* oxlint-disable jsx-a11y/prefer-tag-over-role -- an svg chart gets its name through role="img" */
import { Chart, SERIES_BG, SERIES_FILL } from "./Chart";

const W = 320;
const H = 112;
const LABEL = 16;

/** Columns stacked by series, one slot per row; a row with nothing in it keeps its slot and shows a tick. */
export function StackedBars({
  title,
  meaning,
  rows,
  keys,
  format,
}: {
  title: string;
  meaning: string;
  rows: { label: string; parts: { key: string; value: number }[] }[];
  keys: string[];
  format: (n: number) => string;
}) {
  const totals = rows.map((r) => r.parts.reduce((sum, p) => sum + p.value, 0));
  const max = Math.max(...totals, 0);
  const slot = W / Math.max(rows.length, 1);
  const every = Math.ceil(rows.length / 8);
  const bar = Math.min(slot * 0.62, 28);
  const plot = H - LABEL;
  return (
    <Chart title={title} meaning={meaning}>
      <svg role="img" aria-label={title} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        {rows.map((row, i) => {
          const x = i * slot + (slot - bar) / 2;
          let y = plot;
          return (
            <g key={`${row.label}-${i}`} data-slot="row" data-empty={totals[i] === 0}>
              {totals[i] === 0 ? (
                <rect x={x} y={plot - 1.5} width={bar} height={1.5} className="fill-border" />
              ) : (
                row.parts
                  .filter((p) => p.value > 0)
                  .map((p) => {
                    const h = Math.max((p.value / max) * (plot - 6), 1.5);
                    y -= h;
                    return (
                      <rect
                        key={p.key}
                        x={x}
                        y={y}
                        width={bar}
                        height={h}
                        rx={1}
                        className={SERIES_FILL[Math.max(keys.indexOf(p.key), 0) % SERIES_FILL.length]}
                      >
                        <title>{`${row.label}, ${p.key}: ${format(p.value)}`}</title>
                      </rect>
                    );
                  })
              )}
              {i % every === 0 ? (
                <text x={i * slot + slot / 2} y={H - 3} textAnchor="middle" className="fill-muted font-mono text-[8px]">
                  {row.label}
                </text>
              ) : null}
            </g>
          );
        })}
        <line x1={0} x2={W} y1={plot} y2={plot} className="stroke-border" strokeWidth={1} />
      </svg>
      <ul className="text-muted flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {keys.map((k, i) => (
          <li key={k} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-2 rounded-[2px] ${SERIES_BG[i % SERIES_BG.length]}`} />
            {k}
          </li>
        ))}
      </ul>
    </Chart>
  );
}
