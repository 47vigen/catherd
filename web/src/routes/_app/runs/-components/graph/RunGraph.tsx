import { Spinner } from "@heroui/react";
import { Background, Controls, type Edge, MiniMap, ReactFlow } from "@xyflow/react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { layoutKey, layoutRunModel, type StepNode } from "../../-lib/layout";
import { STATUS_TONE, type Tone } from "../../-lib/node-view";
import type { RunModel, RunNode } from "../../../../../client";
import { NodeCard } from "./NodeCard";

const nodeTypes = { step: NodeCard };

// React Flow draws an edge from CSS variables, so a class on the edge picks its colour; these are literals so
// Tailwind sees them. An edge into a running step is animated and green: the run is flowing there.
const EDGE = {
  running: "[--xy-edge-stroke:var(--success)] [--xy-edge-stroke-width:2]",
  done: "[--xy-edge-stroke:color-mix(in_oklab,var(--success)_55%,transparent)]",
  failed: "[--xy-edge-stroke:var(--danger)]",
  parked: "[--xy-edge-stroke:var(--warning)]",
  idle: "[--xy-edge-stroke:color-mix(in_oklab,var(--muted)_40%,transparent)] [&_path]:[stroke-dasharray:4_4]",
} as const;

function edgeClass(from: RunNode["status"] | undefined, to: RunNode["status"] | undefined): string {
  if (to === "running") return EDGE.running;
  if (to === "failed") return EDGE.failed;
  if (to === "parked") return EDGE.parked;
  if (to === "done" && from === "done") return EDGE.done;
  return EDGE.idle;
}

const MINIMAP: Record<Tone, string> = {
  running: "var(--success)",
  success: "color-mix(in oklab, var(--success) 60%, transparent)",
  danger: "var(--danger)",
  warning: "var(--warning)",
  muted: "var(--border)",
};

// The canvas colours come from the theme through React Flow's own variables, so light and dark both follow.
const FRAME = [
  "border-border h-[clamp(420px,62vh,720px)] w-full overflow-hidden rounded-sm border",
  "[--xy-background-color:var(--surface-secondary)]",
  "[--xy-background-pattern-color:var(--border)]",
  "[--xy-controls-button-background-color:var(--surface)]",
  "[--xy-controls-button-background-color-hover:var(--surface-secondary)]",
  "[--xy-controls-button-color:var(--foreground)]",
  "[--xy-controls-button-border-color:var(--border)]",
  "[--xy-controls-box-shadow:0_0_0_1px_var(--border)]",
  "[--xy-minimap-background-color:var(--surface)]",
  "[--xy-minimap-mask-background-color:color-mix(in_oklab,var(--background)_65%,transparent)]",
  "[--xy-attribution-background-color:transparent]",
  "motion-reduce:[&_.animated_path]:animate-none",
].join(" ");

/** The run as a graph, left to right. Only a change in the shape of the run lays it out again. */
export function RunGraph({
  model,
  selected,
  now,
  onOpen,
}: {
  model: RunModel;
  selected: string | undefined;
  /** The time the running steps count to, in ms. */
  now: number;
  onOpen: (id: string) => void;
}) {
  const key = layoutKey(model);
  const [laid, setLaid] = useState<{ key: string; nodes: StepNode[]; edges: Edge[] }>();
  const latest = useEffectEvent(() => model);

  useEffect(() => {
    let current = true;
    void layoutRunModel(latest()).then((l) => {
      if (current) setLaid({ key, ...l });
    });
    return () => {
      current = false;
    };
  }, [key]);

  // Positions come from the layout; everything a status change touches is read from the model on each render.
  const { nodes, edges } = useMemo(() => {
    if (!laid) return { nodes: [], edges: [] };
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    return {
      nodes: laid.nodes.map((n) => ({
        ...n,
        selected: n.id === selected,
        data: { node: byId.get(n.id) ?? n.data.node, now, onOpen },
      })),
      edges: laid.edges.map((e) => ({
        ...e,
        animated: byId.get(e.target)?.status === "running",
        className: edgeClass(byId.get(e.source)?.status, byId.get(e.target)?.status),
      })),
    };
  }, [laid, model, selected, now, onOpen]);

  if (!laid)
    return (
      <div className={`${FRAME} flex items-center justify-center`}>
        <Spinner size="sm" />
      </div>
    );

  return (
    <div className={FRAME}>
      <ReactFlow
        key={laid.key}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
        minZoom={0.15}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        // Selectable only so React Flow lets pointer events reach the card, which is a button.
        elementsSelectable
        zoomOnScroll={false}
        preventScrolling={false}
        aria-label="Graph of the run"
        attributionPosition="bottom-left"
      >
        <Background gap={22} size={1.5} />
        <Controls position="top-right" showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          ariaLabel="Overview of the run"
          nodeColor={(n) => MINIMAP[STATUS_TONE[(n.data as StepNode["data"]).node.status]]}
        />
      </ReactFlow>
    </div>
  );
}
