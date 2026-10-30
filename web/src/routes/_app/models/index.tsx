import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { rangeOf } from "../-dashboard/format";
import { getCatalogOptions, getOverviewOptions } from "../../../client/@tanstack/react-query.gen";
import { DataList } from "../../../components/data-list/DataList";
import { PageHeader } from "../../../components/page-header/PageHeader";
import { Tile } from "../../../components/tile/Tile";
import { modelName } from "../../../lib/model-name";
import { CostChart } from "./-components/CostChart";
import { EffortTable } from "./-components/EffortTable";
import { ModelList } from "./-components/ModelList";
import { brandOfModel, frontierOf, seriesOf, standouts } from "./-lib/series";

export const Route = createFileRoute("/_app/models/")({ component: ModelsPage });

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const money = (v: number) => `$${Number(v.toPrecision(2))}`;

function ModelsPage() {
  const catalog = useQuery(getCatalogOptions());
  // what we actually ran in the last 30 days, so the catalog reads against our own use
  const [range] = useState(() => rangeOf(30, new Date().toISOString().slice(0, 10)));
  const overview = useQuery(getOverviewOptions({ query: range }));
  const [scale, setScale] = useState<"log" | "linear">("log");
  // the models switched away from where they start: a model a newer version replaces starts off
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const models = catalog.data?.models ?? [];
  const hidden = new Set(models.filter((m) => m.superseded !== flipped.has(m.id)).map((m) => m.id));
  const { series, dropped } = seriesOf(models, hidden, scale);
  const frontier = frontierOf(series);
  const toggle = (id: string) =>
    setFlipped((h) => {
      const next = new Set(h);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const indexedAt = catalog.data?.indexedAt;
  const usage = new Map(
    (overview.data?.tokensByModel ?? []).filter((u) => u.model !== "other").map((u) => [u.model, u.tokens]),
  );
  const used = [...usage].sort((a, b) => b[1] - a[1])[0];
  const usedTotal = [...usage.values()].reduce((a, b) => a + b, 0);
  const { top, value } = standouts(models);
  const labs = new Set(models.map(brandOfModel)).size;
  const replaced = models.filter((m) => m.superseded).length;

  const axis = (
    <ToggleButtonGroup
      aria-label="Cost axis"
      size="sm"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={new Set([scale])}
      onSelectionChange={(k) => setScale(k.has("linear") ? "linear" : "log")}
    >
      <ToggleButton id="log" className="h-7 text-xs">
        Log
      </ToggleButton>
      <ToggleButton id="linear" className="h-7 text-xs">
        <ToggleButtonGroup.Separator />
        Linear
      </ToggleButton>
    </ToggleButtonGroup>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Models"
        description={
          <>
            Every model catherd can route to, by what it scores and what a task costs. Data: Slopalytics (Artificial
            Analysis), {indexedAt ? `fetched ${indexedAt.slice(0, 10)}` : "not fetched yet"}.
          </>
        }
      />
      <DataList.State
        isLoading={catalog.isLoading}
        error={catalog.error}
        isEmpty={models.length === 0}
        emptyText="No model is indexed yet. Run catherd catalog sync, then reload."
      >
        <Tile.Stats className="md:grid-cols-4 xl:grid-cols-4">
          <Tile.Stat
            label="Models"
            value={models.length - replaced}
            hint={`${labs} ${labs === 1 ? "lab" : "labs"} · ${replaced} replaced by a newer version`}
          />
          <Tile.Stat
            label="Smartest"
            value={<span className="text-[22px]">{top?.model ?? "–"}</span>}
            hint={
              top
                ? `${top.intelligence.toFixed(1)} at ${top.effort}${top.usd !== null ? ` · ${money(top.usd)} a task` : ""}`
                : undefined
            }
          />
          <Tile.Stat
            label="Best value"
            value={<span className="text-accent text-[22px]">{value ? `${value.model}` : "–"}</span>}
            hint={
              value
                ? `${value.effort} · ${value.intelligence.toFixed(1)} for ${money(value.usd!)} a task, within 10% of the top`
                : undefined
            }
          />
          <Tile.Stat
            label="Most used"
            value={<span className="text-[22px]">{used ? modelName(used[0]) : "–"}</span>}
            hint={
              used
                ? `${compact.format(used[1])} tokens · ${Math.round((used[1] / usedTotal) * 100)}% of the last 30 days`
                : "no run in the last 30 days"
            }
          />
        </Tile.Stats>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Tile
            title="Cost against intelligence"
            aside={
              <span className="flex items-center gap-3">
                <span className="text-muted hidden items-center gap-1.5 text-xs sm:flex">
                  <span aria-hidden="true" className="bg-accent/30 h-1.5 w-4 rounded-full" />
                  Best for the money
                </span>
                {axis}
              </span>
            }
            className="lg:col-span-8"
          >
            <CostChart
              series={series}
              scale={scale}
              frontier={frontier}
              className="h-[26rem] w-full px-2 pt-4 pb-2 max-sm:h-80"
            />
            <p className="text-muted border-border mt-auto border-t px-4 py-2.5 text-xs">
              Up and to the left is better. A lab&apos;s stronger models are drawn deeper; a point&apos;s tooltip says
              whether its cost is measured or estimated.
              {dropped > 0 ? ` ${dropped} points have no known cost and are not drawn.` : null}
            </p>
          </Tile>
          <Tile
            title="Available to us"
            aside={<span className="text-muted font-mono text-xs">{series.length} shown</span>}
            className="lg:col-span-4 lg:h-[33rem]"
            bodyClassName="overflow-y-auto"
          >
            <section aria-label="Available to us">
              <ModelList models={models} hidden={hidden} onToggle={toggle} usage={usage} />
            </section>
          </Tile>
          <Tile
            title="Every effort"
            aside={<span className="text-muted text-xs">score, then price per task · * estimated</span>}
            className="lg:col-span-12"
          >
            <EffortTable models={models} hidden={hidden} />
          </Tile>
        </div>
      </DataList.State>
    </div>
  );
}
