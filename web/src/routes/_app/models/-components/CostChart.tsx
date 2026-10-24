import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { logTicks, type Series } from "../-lib/series";
import { AXIS_TICK, ChartTooltip, GRID_STROKE } from "../../../../components/charts/ChartTooltip";
import { BRAND_BG, brandFill } from "../../../../lib/brand";

type Point = Series["points"][number];

const money = (v: number) => (v >= 100 ? `$${Math.round(v)}` : `$${Number(v.toPrecision(2))}`);

/** Intelligence against cost per task, one line per model and one dot per effort. */
export function CostChart({ series, scale }: { series: Series[]; scale: "log" | "linear" }) {
  const costs = series.flatMap((s) => s.points.map((p) => p.usd));
  const ticks = scale === "log" && costs.length > 0 ? logTicks(Math.min(...costs), Math.max(...costs)) : undefined;
  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a chart is not an image file
      role="img"
      aria-label={`Cost vs intelligence of ${series.length} models`}
      className="h-96 min-h-72 w-full p-4 max-sm:h-80"
    >
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
        <LineChart margin={{ top: 4, right: 12, left: 0, bottom: 16 }}>
          <CartesianGrid stroke={GRID_STROKE} />
          <XAxis
            type="number"
            dataKey="usd"
            scale={scale}
            domain={ticks ? [ticks[0]!, ticks[ticks.length - 1]!] : [0, "auto"]}
            ticks={ticks}
            allowDataOverflow
            tick={AXIS_TICK}
            tickFormatter={money}
            label={{ value: "Cost per task (USD)", position: "insideBottom", offset: -10, ...AXIS_TICK }}
          />
          <YAxis
            type="number"
            dataKey="intelligence"
            domain={["auto", "auto"]}
            tick={AXIS_TICK}
            width={44}
            label={{ value: "Intelligence index", angle: -90, position: "insideLeft", ...AXIS_TICK }}
          />
          <Tooltip
            shared={false}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as Point | undefined) : undefined;
              const s = series.find((x) => x.points.includes(p as Point));
              if (!p || !s) return null;
              return (
                <ChartTooltip title={s.name}>
                  <ChartTooltip.Row swatch={BRAND_BG[s.brand]} label="Effort" value={p.effort} />
                  <ChartTooltip.Row swatch={BRAND_BG[s.brand]} label="Intelligence" value={p.intelligence} />
                  <ChartTooltip.Row
                    swatch={BRAND_BG[s.brand]}
                    label={`$${Number(p.usd.toPrecision(3))} per task`}
                    value={p.measured ? "measured" : "estimated"}
                  />
                </ChartTooltip>
              );
            }}
          />
          {series.map((s) => (
            <Line
              key={s.id}
              data={s.points}
              name={s.name}
              dataKey="intelligence"
              stroke={brandFill(s.brand)}
              strokeDasharray={s.dash || undefined}
              strokeWidth={1.5}
              isAnimationActive={false}
              dot={(d: { cx?: number; cy?: number; index?: number; payload?: Point }) => (
                <circle
                  key={d.index}
                  cx={d.cx}
                  cy={d.cy}
                  r={3.5}
                  stroke={brandFill(s.brand)}
                  strokeWidth={1.5}
                  fill={d.payload?.measured ? brandFill(s.brand) : "var(--surface)"}
                />
              )}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
