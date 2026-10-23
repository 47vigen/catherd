import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { memo, useState } from "react";
import { Bar, BarChart, BarStack, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { Overview } from "../../../client";
import { AXIS_TICK, ChartTooltip, CURSOR_FILL, GRID_STROKE } from "../../../components/charts/ChartTooltip";
import { Tile } from "../../../components/tile/Tile";
import { backendTone, type DailyRow, dailyRows, formatCost, formatCount, type Metric } from "./format";

const axisMoney = (v: number) => (v >= 100 ? `$${Math.round(v)}` : `$${Number(v.toFixed(2))}`);

/** Spend or tokens per day, one stacked column per day and one colour per backend. */
function DailyChartImpl({ data, days, className }: { data: Overview; days: number; className?: string }) {
  const [picked, setPicked] = useState<Metric | null>(null);
  const metric = picked ?? (data.kpis.costUsd > 0 ? "cost" : "tokens");
  const { keys, rows } = dailyRows(data.daily, metric, days);
  const format = metric === "cost" ? formatCost : formatCount;
  const total = rows.reduce((n, r) => n + r.total, 0);

  return (
    <Tile
      title={metric === "cost" ? "Cost per day" : "Tokens per day"}
      className={className}
      aside={
        <ToggleButtonGroup
          aria-label="Plot"
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([metric])}
          onSelectionChange={(k) => setPicked(k.has("tokens") ? "tokens" : "cost")}
        >
          <ToggleButton id="cost" className="h-7 text-xs">
            Cost
          </ToggleButton>
          <ToggleButton id="tokens" className="h-7 text-xs">
            <ToggleButtonGroup.Separator />
            Tokens
          </ToggleButton>
        </ToggleButtonGroup>
      }
      bodyClassName="gap-4 p-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <p className="flex items-baseline gap-2">
          <span className="text-xl leading-none font-medium tracking-[-0.02em] tabular-nums">{format(total)}</span>
          <span className="text-muted text-xs">in {days} days</span>
        </p>
        {keys.length > 0 ? (
          <ul aria-label="Backends" className="text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {keys.map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <span aria-hidden="true" className={`size-2 rounded-[2px] ${backendTone(k).bg}`} />
                {k}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="relative min-h-56 flex-1">
        {keys.length === 0 ? (
          <p className="text-muted absolute inset-0 z-10 flex items-center justify-center pb-6 text-sm">
            Nothing ran in this range.
          </p>
        ) : null}
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
          <BarChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="22%">
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis
              dataKey="label"
              tick={{ ...AXIS_TICK, dy: 4 }}
              tickLine={false}
              axisLine={false}
              interval={Math.ceil(rows.length / 8) - 1}
            />
            <YAxis
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={44}
              tickCount={4}
              tickFormatter={(v: number) => (metric === "cost" ? axisMoney(v) : formatCount(v))}
              // An empty range keeps a scale, so the plot reads as zero days rather than a missing chart.
              domain={keys.length > 0 ? [0, "auto"] : [0, metric === "cost" ? 3 : 3000]}
            />
            <Tooltip
              cursor={CURSOR_FILL}
              content={({ active, payload }) => {
                const row = active ? (payload?.[0]?.payload as DailyRow | undefined) : undefined;
                if (!row) return null;
                return (
                  <ChartTooltip title={row.day}>
                    {keys
                      .filter((k) => (row.values[k] ?? 0) > 0)
                      .map((k) => (
                        <ChartTooltip.Row key={k} swatch={backendTone(k).bg} label={k} value={format(row.values[k]!)} />
                      ))}
                    <ChartTooltip.Row label={row.total > 0 ? "Total" : "Nothing ran"} value={format(row.total)} />
                  </ChartTooltip>
                );
              }}
            />
            <BarStack radius={[3, 3, 0, 0]}>
              {keys.map((k) => (
                <Bar
                  key={k}
                  dataKey={(r: DailyRow) => r.values[k] ?? 0}
                  name={k}
                  stackId="day"
                  fill={backendTone(k).fill}
                  maxBarSize={36}
                  isAnimationActive={false}
                />
              ))}
            </BarStack>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Tile>
  );
}

export const DailyChart = memo(DailyChartImpl);
