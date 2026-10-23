import type { Overview } from "../../../client";
import { Blocks } from "../../../components/charts/Blocks";
import { Sparkline } from "../../../components/charts/Sparkline";
import { Tile } from "../../../components/tile/Tile";
import { dailyTotals, formatCost, formatCount, formatMinutes } from "./format";

/** The six headline figures of the range on one hairline sheet; spend and tokens carry their daily line. */
export function StatSheet({ data, className }: { data: Overview; className?: string }) {
  const { kpis } = data;
  return (
    <Tile.Stats className={className}>
      <Tile.Stat label="Runs" value={String(kpis.runs)} hint={`${kpis.ended} ended`} />
      <Tile.Stat
        label="Finished alone"
        value={kpis.cleanPct === null ? "–" : `${Math.round(kpis.cleanPct)}%`}
        hint={kpis.ended > 0 ? `${kpis.clean} of ${kpis.ended} without you` : "no run ended yet"}
        trend={kpis.ended > 0 ? <Blocks value={kpis.clean} max={kpis.ended} className="mt-1" /> : undefined}
      />
      <Tile.Stat label="Median time" value={formatMinutes(kpis.medianWallMinutes)} hint="per finished run" />
      <Tile.Stat
        label="Interventions"
        value={String(kpis.interventions)}
        hint={kpis.interventions === 1 ? "time a run needed you" : "times a run needed you"}
      />
      <Tile.Stat
        label="Cost"
        value={formatCost(kpis.costUsd)}
        trend={<Sparkline values={dailyTotals(data.daily, "cost")} />}
      />
      <Tile.Stat
        label="Tokens"
        value={formatCount(kpis.tokens)}
        trend={<Sparkline values={dailyTotals(data.daily, "tokens")} />}
      />
    </Tile.Stats>
  );
}
