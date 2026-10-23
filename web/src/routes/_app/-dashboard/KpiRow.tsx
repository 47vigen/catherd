import type { Overview } from "../../../client";
import { Kpi } from "../../../components/kpi/Kpi";
import { formatCost, formatCount, formatMinutes } from "./format";

/** The six headline figures of the range; each says in one line what it tells you. */
export function KpiRow({ kpis }: { kpis: Overview["kpis"] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Kpi label="Runs" value={String(kpis.runs)} meaning="Runs started in this range." />
      <Kpi
        label="Finished without you"
        value={kpis.cleanPct === null ? "–" : `${Math.round(kpis.cleanPct)}%`}
        meaning="Runs that ended done with no answer, approval or cancel from you."
      />
      <Kpi
        label="Median wall time"
        value={formatMinutes(kpis.medianWallMinutes)}
        meaning="Half the finished runs took less than this."
      />
      <Kpi
        label="Interventions"
        value={String(kpis.interventions)}
        meaning="Times a run needed you: answers, approvals, cancels and pauses."
      />
      <Kpi
        label="Cost"
        value={formatCost(kpis.costUsd)}
        meaning="Dollars the backends reported; subscription plans report none."
      />
      <Kpi label="Tokens" value={formatCount(kpis.tokens)} meaning="Input and output tokens over every dispatch." />
    </div>
  );
}
