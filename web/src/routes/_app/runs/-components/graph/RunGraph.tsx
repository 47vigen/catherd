import { ArrowsExpand, Frame, MagnifierMinus, MagnifierPlus } from "@gravity-ui/icons";
import { Button, Spinner } from "@heroui/react";
import { type Edge, ReactFlow } from "@xyflow/react";
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useColorMode } from "../../-hooks/useColorMode";
import { absolutePosition, CARD, type GraphNode, layoutKey, layoutRunModel } from "../../-lib/layout";
import type { RunModel, RunNode, RunView } from "../../../../../client";
import { MilestoneGroup } from "./MilestoneGroup";
import { EndPill, NodeCard } from "./NodeCard";

const nodeTypes = { step: NodeCard, pill: EndPill, milestone: MilestoneGroup };

// React Flow draws an edge from CSS variables, so a class on the edge picks its colour; these are literals so
// Tailwind sees them. The flow into a running step moves; the path already walked is quiet; the rest is dashed.
const EDGE = {
  running: "[--xy-edge-stroke:var(--success)] [--xy-edge-stroke-width:2]",
  done: "[--xy-edge-stroke:color-mix(in_oklab,var(--muted)_70%,transparent)] [--xy-edge-stroke-width:1.5]",
  failed: "[--xy-edge-stroke:var(--danger)] [--xy-edge-stroke-width:1.5]",
  parked: "[--xy-edge-stroke:var(--warning)] [--xy-edge-stroke-width:1.5]",
  idle: "[--xy-edge-stroke:color-mix(in_oklab,var(--muted)_40%,transparent)] [&_path]:[stroke-dasharray:4_4]",
} as const;

function edgeClass(from: RunNode["status"] | undefined, to: RunNode["status"] | undefined): string {
  if (to === "running") return EDGE.running;
  if (to === "failed") return EDGE.failed;
  if (to === "parked") return EDGE.parked;
  if (from === "done" && to && to !== "pending") return EDGE.done;
  return EDGE.idle;
}

/** Room around the graph, in pixels. */
const PAD = 24;

/** The zoom the buttons step through: each press multiplies or divides by `step`. */
export const ZOOM = { min: 0.25, max: 2, step: 1.25 } as const;
const clampZoom = (z: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, z));

// The canvas is the size of the graph at the chosen zoom inside a frame that scrolls natively: a wide run is swiped or
// scrolled sideways like a CI pipeline, the page keeps its own vertical scroll, and it opens at full scale.
const FRAME = [
  "bg-background w-full overflow-auto overscroll-x-contain",
  "bg-[radial-gradient(color-mix(in_oklab,var(--muted)_22%,transparent)_1px,transparent_1px)] bg-size-[20px_20px]",
].join(" ");
const CANVAS = [
  // React Flow's own sheet sets `position: relative` outside any layer, so these must win with `!`.
  "absolute! inset-0",
  "[--xy-background-color:transparent]",
  "[--xy-attribution-background-color:transparent]",
  "[&_.react-flow\\_\\_attribution]:opacity-40",
  "motion-reduce:[&_.animated_path]:animate-none",
].join(" ");

type Laid = { key: string; nodes: GraphNode[]; edges: Edge[]; width: number; height: number };

/** The run as a pipeline: milestones as stages, left to right. Only a change in its shape lays it out again. */
export function RunGraph({
  model,
  milestones,
  selected,
  now,
  onOpen,
  onExpand,
  fill = false,
}: {
  model: RunModel;
  milestones: RunView["milestones"];
  selected: string | undefined;
  /** The time the running steps count to, in ms. */
  now: number;
  onOpen: (id: string) => void;
  /** Adds a Full screen button; the caller shows the graph larger. */
  onExpand?: () => void;
  /** Fills its parent's height instead of capping at the page's. */
  fill?: boolean;
}) {
  const colorMode = useColorMode();
  const key = layoutKey(model);
  const [laid, setLaid] = useState<Laid>();
  const frame = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  // The point at the frame's centre, in unscaled pixels, to hold still across a zoom change.
  const anchor = useRef<{ x: number; y: number }>(null);
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

  // A run that is running (or waiting) opens scrolled to that step; the user's own scroll is never taken back.
  const scrollToActive = useEffectEvent(() => {
    const el = frame.current;
    const active = model.nodes.find((n) => n.status === "running" || n.status === "parked");
    const at = laid && active ? absolutePosition(laid.nodes, active.id) : null;
    if (!el || !at) return;
    el.scrollLeft = Math.max(0, zoom * (PAD + at.x + CARD.width / 2) - el.clientWidth / 2);
    el.scrollTop = Math.max(0, zoom * (PAD + at.y + CARD.height / 2) - el.clientHeight / 2);
  });
  useLayoutEffect(() => scrollToActive(), [laid?.key]);

  const zoomTo = (next: number) => {
    const el = frame.current;
    if (el)
      anchor.current = {
        x: (el.scrollLeft + el.clientWidth / 2) / zoom,
        y: (el.scrollTop + el.clientHeight / 2) / zoom,
      };
    setZoom(clampZoom(next));
  };
  useLayoutEffect(() => {
    const el = frame.current;
    const at = anchor.current;
    anchor.current = null;
    if (!el || !at) return;
    el.scrollLeft = Math.max(0, at.x * zoom - el.clientWidth / 2);
    el.scrollTop = Math.max(0, at.y * zoom - el.clientHeight / 2);
  }, [zoom]);

  // Positions come from the layout; everything a status change touches is read from the model on each render.
  const { nodes, edges } = useMemo(() => {
    if (!laid) return { nodes: [], edges: [] };
    const byId = new Map(model.nodes.map((n) => [n.id, n]));
    const titles = new Map(milestones.map((m) => [m.id, m]));
    return {
      nodes: laid.nodes.map((n): GraphNode => {
        if (n.type === "milestone") {
          const m = titles.get(n.data.milestone);
          const steps = n.data.nodes.map((s) => byId.get(s.id) ?? s);
          return { ...n, data: { ...n.data, nodes: steps, title: m?.title ?? null, status: m?.status ?? null } };
        }
        return { ...n, selected: n.id === selected, data: { node: byId.get(n.id) ?? n.data.node, now, onOpen } };
      }),
      edges: laid.edges.map((e): Edge => ({
        ...e,
        animated: byId.get(e.target)?.status === "running",
        className: edgeClass(byId.get(e.source)?.status, byId.get(e.target)?.status),
      })),
    };
  }, [laid, model, milestones, selected, now, onOpen]);

  if (!laid)
    return (
      <div className={`${FRAME} flex h-56 items-center justify-center`}>
        <Spinner size="sm" />
      </div>
    );

  const w = laid.width + 2 * PAD;
  const h = laid.height + 2 * PAD;
  // Never above 100 %: a graph smaller than the frame is shown as it is.
  const fit = () => {
    const el = frame.current;
    zoomTo(el ? Math.min(el.clientWidth / w, el.clientHeight / h, 1) : 1);
  };
  return (
    <div className={fill ? "flex min-h-0 flex-1 flex-col" : undefined}>
      <div
        role="toolbar"
        aria-label="Graph view"
        className="border-border bg-surface flex shrink-0 items-center justify-end gap-1 border-b px-2 py-1"
      >
        <Button
          isIconOnly
          size="sm"
          variant="secondary"
          aria-label="Zoom out"
          isDisabled={zoom <= ZOOM.min}
          onPress={() => zoomTo(zoom / ZOOM.step)}
        >
          <MagnifierMinus />
        </Button>
        <output aria-label="Zoom" className="text-muted w-10 text-center font-mono text-xs tabular-nums">
          {Math.round(zoom * 100)}%
        </output>
        <Button
          isIconOnly
          size="sm"
          variant="secondary"
          aria-label="Zoom in"
          isDisabled={zoom >= ZOOM.max}
          onPress={() => zoomTo(zoom * ZOOM.step)}
        >
          <MagnifierPlus />
        </Button>
        <Button isIconOnly size="sm" variant="secondary" aria-label="Fit to view" onPress={fit}>
          <Frame />
        </Button>
        {onExpand ? (
          <Button isIconOnly size="sm" variant="secondary" aria-label="Full screen" onPress={onExpand}>
            <ArrowsExpand />
          </Button>
        ) : null}
      </div>
      <div ref={frame} className={`${FRAME} ${fill ? "min-h-0 flex-1" : "max-h-[72vh]"}`}>
        <div className="relative mx-auto w-fit">
          {/* Sizes the canvas to the graph; an svg's own width and height are attributes, not styles. */}
          <svg aria-hidden="true" width={w * zoom} height={h * zoom} className="block" />
          <ReactFlow
            key={laid.key}
            className={CANVAS}
            colorMode={colorMode}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            viewport={{ x: PAD * zoom, y: PAD * zoom, zoom }}
            minZoom={ZOOM.min}
            maxZoom={ZOOM.max}
            panOnDrag={false}
            panOnScroll={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            // Selectable only so React Flow lets pointer events reach the card, which is a button.
            elementsSelectable
            aria-label="Graph of the run"
            attributionPosition="bottom-left"
          />
        </div>
      </div>
    </div>
  );
}
