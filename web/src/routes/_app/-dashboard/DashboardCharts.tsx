import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { type ReactNode, useState } from "react";

import type { Overview } from "../../../client";
import { Bars } from "../../../components/charts/Bars";
import { Chart } from "../../../components/charts/Chart";
import { StackedBars } from "../../../components/charts/StackedBars";
import { dailyRows, formatCost, formatCount, formatSecs, type Metric } from "./format";

const Panel = ({ children }: { children: ReactNode }) => (
  <div className="border-border bg-surface flex min-w-0 flex-col gap-3 rounded-sm border p-4">{children}</div>
);

function NoData({ title, meaning }: { title: string; meaning: string }) {
  return (
    <Panel>
      <Chart title={title} meaning={meaning}>
        <p className="text-muted text-sm">Nothing in this range yet.</p>
      </Chart>
    </Panel>
  );
}

/** The four small charts of the range; on a phone they stack in one column. */
export function DashboardCharts({ data, days }: { data: Overview; days: number }) {
  const [picked, setPicked] = useState<Metric | null>(null);
  const metric = picked ?? (data.kpis.costUsd > 0 ? "cost" : "tokens");
  const daily = dailyRows(data.daily, metric, days);
  const perDay = {
    title: "Cost and tokens per day",
    meaning: "Cost and tokens per day by backend: which backends your runs lean on.",
  };
  const models = {
    title: "Tokens by model",
    meaning: "Tokens by model: where the tokens go.",
  };
  const roles = { title: "Time by role", meaning: "Time by role: which roles take the hours." };
  const rungs = {
    title: "Failovers and climbs",
    meaning: "Failovers and climbs: how often a rung ran out or was too weak.",
  };

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Panel>
        <ToggleButtonGroup
          aria-label="Plot"
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([metric])}
          onSelectionChange={(keys) => setPicked(keys.has("tokens") ? "tokens" : "cost")}
          className="self-end"
        >
          <ToggleButton id="cost">Cost</ToggleButton>
          <ToggleButton id="tokens">
            <ToggleButtonGroup.Separator />
            Tokens
          </ToggleButton>
        </ToggleButtonGroup>
        <StackedBars
          {...perDay}
          rows={daily.rows}
          keys={daily.keys}
          format={metric === "cost" ? formatCost : formatCount}
        />
      </Panel>
      {data.tokensByModel.length === 0 ? (
        <NoData {...models} />
      ) : (
        <Panel>
          <Bars
            {...models}
            rows={data.tokensByModel.map((m) => ({ label: m.model, value: m.tokens }))}
            format={formatCount}
          />
        </Panel>
      )}
      {data.secsByRole.length === 0 ? (
        <NoData {...roles} />
      ) : (
        <Panel>
          <Bars {...roles} rows={data.secsByRole.map((r) => ({ label: r.role, value: r.secs }))} format={formatSecs} />
        </Panel>
      )}
      <Panel>
        <Bars
          {...rungs}
          rows={[
            { label: "Failovers", value: data.failovers },
            { label: "Climbs", value: data.climbs },
          ]}
          format={String}
        />
      </Panel>
    </div>
  );
}
