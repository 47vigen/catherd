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
/** The overlay toolbar's buttons: smaller than HeroUI's sm, so the bar stays a small chip over the graph. */
const TOOL = "size-7 min-w-7";
const clampZoom = (z: number) => Math.min(ZOOM.max, Math.max(ZOOM.min, z));

// The canvas is the size of the graph at the chosen zoom inside a frame that scrolls natively: a wide run is swiped or
// scrolled sideways like a CI pipeline, the page keeps its own vertical scroll, and it opens at full scale.
const FRAME = [
  "bg-background w-full overflow-auto overscroll-x-contain cursor-grab data-panning:cursor-grabbing data-panning:select-none",
  "bg-[radial-gradient(color-mix(in_oklab,var(--muted)_22%,transparent)_1px,transparent_1px)] bg-size-[20px_20px]",
].join(" ");
const CANVAS = [
  // React Flow's own sheet sets `position: relative` outside any layer, so these must win with `!`.
  "absolute! inset-0",
  "[--xy-background-color:transparent]",
  "[&_.react-flow\\_\\_pane]:cursor-[inherit]",
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
  // A point of the graph, in unscaled pixels, and where it sits in the frame, to hold still across a zoom change.
  const anchor = useRef<{ x: number; y: number; left: number; top: number }>(null);
  // A mouse drag on the frame scrolls it; past a few pixels it is a pan, not a click on the card under it.
  const pan = useRef<{ x: number; y: number; left: number; top: number; moved: boolean }>(null);
  const [panning, setPanning] = useState(false);
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

  /** Zooms around `at`, a point in the frame (its centre by default). */
  const zoomTo = (next: number, at?: { left: number; top: number }) => {
    const el = frame.current;
    if (el) {
      const { left, top } = at ?? { left: el.clientWidth / 2, top: el.clientHeight / 2 };
      anchor.current = { x: (el.scrollLeft + left) / zoom, y: (el.scrollTop + top) / zoom, left, top };
    }
    setZoom(clampZoom(next));
  };
  // A trackpad pinch arrives as a wheel event with ctrlKey; in full screen it zooms around the pointer, not the page.
  const pinch = useEffectEvent((e: WheelEvent) => {
    if (!fill || !e.ctrlKey || !frame.current) return;
    e.preventDefault();
    const box = frame.current.getBoundingClientRect();
    zoomTo(zoom * Math.exp(-e.deltaY * 0.01), { left: e.clientX - box.left, top: e.clientY - box.top });
  });
  const ready = laid !== undefined;
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    // React's onWheel is passive, and only a non-passive listener can stop the browser zooming the page.
    const on = (e: WheelEvent) => pinch(e);
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, [ready]);
  useLayoutEffect(() => {
    const el = frame.current;
    const at = anchor.current;
    anchor.current = null;
    if (!el || !at) return;
    el.scrollLeft = Math.max(0, at.x * zoom - at.left);
    el.scrollTop = Math.max(0, at.y * zoom - at.top);
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
    <div className={fill ? "relative flex min-h-0 flex-1 flex-col" : "relative"}>
      {/* Floats over the frame's top right, outside the scroller; full screen leaves the corner to the close button. */}
      <div
        role="toolbar"
        aria-label="Graph view"
        className={`border-border bg-surface/90 absolute z-10 flex items-center gap-0.5 rounded-lg border p-0.5 shadow-sm backdrop-blur ${fill ? "top-3 right-13" : "top-2 right-3"}`}
      >
        {/* Zoom lives in full screen only; the page keeps the graph at full scale. */}
        {fill ? (
          <>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              className={TOOL}
              aria-label="Zoom out"
              isDisabled={zoom <= ZOOM.min}
              onPress={() => zoomTo(zoom / ZOOM.step)}
            >
              <MagnifierMinus />
            </Button>
            <output aria-label="Zoom" className="text-muted w-9 text-center font-mono text-[11px] tabular-nums">
              {Math.round(zoom * 100)}%
            </output>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              className={TOOL}
              aria-label="Zoom in"
              isDisabled={zoom >= ZOOM.max}
              onPress={() => zoomTo(zoom * ZOOM.step)}
            >
              <MagnifierPlus />
            </Button>
            <Button isIconOnly size="sm" variant="ghost" className={TOOL} aria-label="Fit to view" onPress={fit}>
              <Frame />
            </Button>
          </>
        ) : null}
        {onExpand ? (
          <Button isIconOnly size="sm" variant="ghost" className={TOOL} aria-label="Full screen" onPress={onExpand}>
            <ArrowsExpand />
          </Button>
        ) : null}
      </div>
      <div
        ref={frame}
        className={`${FRAME} ${fill ? "flex min-h-0 flex-1" : "max-h-[72vh]"}`}
        data-panning={panning || undefined}
        onPointerDown={(e) => {
          if (e.pointerType !== "mouse" || e.button !== 0) return;
          const el = e.currentTarget;
          pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
        }}
        onPointerMove={(e) => {
          const p = pan.current;
          if (!p) return;
          const dx = e.clientX - p.x;
          const dy = e.clientY - p.y;
          if (!p.moved && Math.hypot(dx, dy) < 4) return;
          if (!p.moved) {
            p.moved = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            setPanning(true);
          }
          e.currentTarget.scrollTo(p.left - dx, p.top - dy);
        }}
        onPointerUp={() => {
          // the click that ends a pan must not open the card under the pointer
          if (pan.current?.moved) setTimeout(() => (pan.current = null));
          else pan.current = null;
          setPanning(false);
        }}
        onPointerCancel={() => {
          pan.current = null;
          setPanning(false);
        }}
        onClickCapture={(e) => {
          if (pan.current?.moved) e.stopPropagation();
        }}
      >
        {/* Full screen centres the graph both ways, clear of the overlays in the corners; auto margins drop to 0 once
            it overflows, so it still scrolls from its edge. */}
        <div className={`relative w-fit ${fill ? "m-auto" : "mx-auto"}`}>
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
            // React Flow is MIT; its badge is a courtesy the owner chose to drop (2026-10-25).
            proOptions={{ hideAttribution: true }}
          />
        </div>
      </div>
    </div>
  );
}
