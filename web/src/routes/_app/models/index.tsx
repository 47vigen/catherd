import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { getCatalogOptions } from "../../../client/@tanstack/react-query.gen";
import { DataList } from "../../../components/data-list/DataList";
import { CostChart } from "./-components/CostChart";
import { ModelList } from "./-components/ModelList";
import { seriesOf } from "./-lib/series";

/** A panel floating over the chart. */
const OVERLAY = "border-border bg-surface/90 rounded-lg border shadow-sm backdrop-blur";

export const Route = createFileRoute("/_app/models/")({ component: ModelsPage });

function ModelsPage() {
  const catalog = useQuery(getCatalogOptions());
  const [scale, setScale] = useState<"log" | "linear">("log");
  // the models switched away from where they start: a model a newer version replaces starts off
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const models = catalog.data?.models ?? [];
  const hidden = new Set(models.filter((m) => m.superseded !== flipped.has(m.id)).map((m) => m.id));
  const { series, dropped } = seriesOf(models, hidden, scale);
  const toggle = (id: string) =>
    setFlipped((h) => {
      const next = new Set(h);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const indexedAt = catalog.data?.indexedAt;

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

  // The chart is the page, edge to edge; the title with the axis switch, the source and the model list float over it.
  // On a wide screen the plot leaves room on the right for the list, so no line ever sits under it.
  return (
    <div className="bg-background relative flex flex-col lg:h-dvh lg:overflow-hidden">
      <header
        className={`${OVERLAY} m-4 flex max-w-xl flex-col gap-1 px-4 py-3 lg:absolute lg:top-0 lg:right-[22rem] lg:left-0 lg:z-10`}
      >
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-lg leading-6 font-medium tracking-[-0.02em]">Models</h1>
          {axis}
        </div>
        <p className="text-muted text-xs">
          Every model catherd can route to. Up and to the left is better: more intelligence for less money per task. A
          lab's stronger models are drawn deeper; the tooltip says whether a cost is measured or estimated.
        </p>
      </header>
      <DataList.State
        isLoading={catalog.isLoading}
        error={catalog.error}
        isEmpty={models.length === 0}
        emptyText="No model is indexed yet. Run catherd catalog sync, then reload."
      >
        <CostChart
          series={series}
          scale={scale}
          className="h-[60dvh] min-h-80 w-full px-2 pt-2 pb-4 lg:absolute lg:inset-0 lg:h-auto lg:pt-32 lg:pr-[23rem] lg:pb-14 lg:pl-4"
        />
        <div className="text-muted flex flex-col gap-1 px-4 pb-4 text-xs lg:absolute lg:bottom-4 lg:left-4 lg:z-10 lg:p-0">
          {dropped > 0 ? <p>{dropped} points have no known cost and are not drawn.</p> : null}
          <p>
            Intelligence and measured cost per task: Slopalytics (Artificial Analysis data),{" "}
            {indexedAt ? `fetched ${indexedAt.slice(0, 10)}` : "not fetched yet"}.
          </p>
        </div>
        <section
          aria-label="Available to us"
          className={`${OVERLAY} mx-4 mb-4 flex min-h-0 flex-col overflow-hidden lg:absolute lg:top-4 lg:right-4 lg:bottom-4 lg:z-10 lg:m-0 lg:w-84`}
        >
          <h2 className="label-caps text-muted border-border shrink-0 border-b px-4 py-3">Available to us</h2>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ModelList models={models} hidden={hidden} onToggle={toggle} />
          </div>
        </section>
      </DataList.State>
    </div>
  );
}
