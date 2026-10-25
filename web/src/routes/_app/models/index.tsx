import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { getCatalogOptions } from "../../../client/@tanstack/react-query.gen";
import { DataList } from "../../../components/data-list/DataList";
import { PageHeader } from "../../../components/page-header/PageHeader";
import { Tile } from "../../../components/tile/Tile";
import { CostChart } from "./-components/CostChart";
import { ModelList } from "./-components/ModelList";
import { seriesOf } from "./-lib/series";

export const Route = createFileRoute("/_app/models/")({ component: ModelsPage });

function ModelsPage() {
  const catalog = useQuery(getCatalogOptions());
  const [scale, setScale] = useState<"log" | "linear">("log");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const models = catalog.data?.models ?? [];
  const { series, dropped } = seriesOf(models, hidden, scale);
  const toggle = (id: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const indexedAt = catalog.data?.indexedAt;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Models"
        description="Every model catherd can route to: how it scores and what one task costs at each effort."
      />
      <DataList.State
        isLoading={catalog.isLoading}
        error={catalog.error}
        isEmpty={models.length === 0}
        emptyText="No model is indexed yet. Run catherd catalog sync, then reload."
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Tile
            title="Cost vs intelligence"
            className="lg:col-span-8"
            aside={
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
            }
          >
            <p className="text-muted px-4 pt-3 text-xs">
              Up and to the left is better: more intelligence for less money per task. Filled dots are measured, hollow
              ones estimated from list prices.
            </p>
            <CostChart series={series} scale={scale} />
            <div className="text-muted flex flex-col gap-1 px-4 pb-4 text-xs">
              {dropped > 0 ? <p>{dropped} points have no known cost and are not drawn.</p> : null}
              <p>
                Intelligence and measured cost per task: Slopalytics (Artificial Analysis data),{" "}
                {indexedAt ? `fetched ${indexedAt.slice(0, 10)}` : "not fetched yet"}.
              </p>
            </div>
          </Tile>
          <Tile title="Available to us" className="lg:col-span-4">
            <ModelList models={models} hidden={hidden} onToggle={toggle} />
          </Tile>
        </div>
      </DataList.State>
    </div>
  );
}
