import type { Edge, Node } from "@xyflow/react";

import type { RunModel, RunNode } from "../../../../client";

export const CARD = { width: 228, height: 76 };
/** A step no model runs (route, commit, land): no model line, so a narrower card. */
export const SMALL_CARD = { width: 168, height: 76 };
export const PILL = { width: 88, height: 32 };

export const ELK_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  // Every step as far left as its inputs allow, so the lanes of a milestone start together in one column.
  "elk.layered.layering.strategy": "LONGEST_PATH_SOURCE",
  // Lanes and milestones stack in plan order, first on top.
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
  "elk.layered.spacing.nodeNodeBetweenLayers": "48",
  "elk.spacing.nodeNode": "20",
};
// Room inside a milestone for its header bar above the steps.
const GROUP_PADDING = "[top=52,left=20,bottom=20,right=20]";

export type StepData = { node: RunNode; now: number; onOpen?: (id: string) => void };
export type StepNode = Node<StepData, "step" | "pill">;
export type GroupData = { milestone: string; title: string | null; nodes: RunNode[]; status: string | null };
export type GroupNode = Node<GroupData, "milestone">;
export type GraphNode = StepNode | GroupNode;

export const groupId = (milestone: string) => `milestone:${milestone}`;
const isPill = (n: RunNode) => n.kind === "start" || n.kind === "end";
export const isSmall = (n: RunNode) => n.role === null && n.kind !== "later";
const sizeOf = (n: RunNode) => (isPill(n) ? PILL : isSmall(n) ? SMALL_CARD : CARD);

/** The shape of the graph: node ids and edges only, so a status change never lays the run out again. */
export const layoutKey = (m: RunModel): string =>
  JSON.stringify([m.nodes.map((n) => n.id), m.edges.map((e) => `${e.from}>${e.to}`)]);

// elkjs is large (1.5 MB): it loads when the first graph needs it, so the page shows its header first.
const elk = import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());

type Box = {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: Box[];
  layoutOptions?: Record<string, string>;
};
type Link = { from: string; to: string };

async function layered(id: string, boxes: Box[], links: Link[], padding?: string): Promise<Box> {
  return (await (
    await elk
  ).layout({
    id,
    layoutOptions: padding ? { ...ELK_OPTIONS, "elk.padding": padding } : ELK_OPTIONS,
    children: boxes,
    edges: links.map((e, i) => ({ id: `${id}#${i}`, sources: [e.from], targets: [e.to] })),
  })) as Box;
}

/**
 * The run laid out like a CI pipeline: each milestone is a labelled box holding its steps, the steps run left to
 * right, lanes that run side by side stack in one column, and start and end are small pills. Each milestone is laid
 * out on its own first, then the run around the boxes (ELK's one-pass compound layout ignores the per-box order
 * options). Positions of the steps inside a milestone are relative to its box, as React Flow takes them.
 */
export async function layoutRunModel(
  model: RunModel,
): Promise<{ nodes: GraphNode[]; edges: Edge[]; width: number; height: number }> {
  const ids = new Set(model.nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const owner = new Map(model.nodes.map((n) => [n.id, n.milestone]));
  const byMilestone = new Map<string, RunNode[]>();
  for (const n of model.nodes)
    if (n.milestone) byMilestone.set(n.milestone, [...(byMilestone.get(n.milestone) ?? []), n]);

  const box = (n: RunNode): Box => ({ id: n.id, ...sizeOf(n) });
  const inner = new Map(
    await Promise.all(
      [...byMilestone].map(
        async ([m, steps]) =>
          [
            m,
            await layered(
              groupId(m),
              steps.map(box),
              edges.filter((e) => owner.get(e.from) === m && owner.get(e.to) === m),
              GROUP_PADDING,
            ),
          ] as const,
      ),
    ),
  );

  // The run around the boxes: a step inside a milestone stands for its box.
  const outer = (id: string) => {
    const m = owner.get(id);
    return m ? groupId(m) : id;
  };
  const top: Box[] = [];
  for (const n of model.nodes) {
    if (!n.milestone) top.push(box(n));
    else if (byMilestone.get(n.milestone)![0] === n) {
      const g = inner.get(n.milestone)!;
      // Milestones in one column start at its left edge, however long each is.
      top.push({
        id: groupId(n.milestone),
        width: g.width,
        height: g.height,
        layoutOptions: { "elk.alignment": "LEFT" },
      });
    }
  }
  const links = new Map<string, Link>();
  for (const e of edges) {
    const from = outer(e.from);
    const to = outer(e.to);
    if (from !== to) links.set(`${from}>${to}`, { from, to });
  }
  const graph = await layered("run", top, [...links.values()]);

  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const step = (c: Box, parentId?: string): StepNode => {
    const n = byId.get(c.id)!;
    return {
      id: n.id,
      type: isPill(n) ? "pill" : "step",
      position: { x: c.x ?? 0, y: c.y ?? 0 },
      ...(parentId ? { parentId, extent: "parent" as const } : {}),
      // Fixed size: React Flow draws the node at once instead of waiting to measure it.
      ...sizeOf(n),
      data: { node: n, now: 0 },
    };
  };
  const nodes: GraphNode[] = [];
  for (const c of graph.children ?? []) {
    const milestone = byId.has(c.id) ? null : c.id.slice(groupId("").length);
    if (milestone === null) {
      nodes.push(step(c));
      continue;
    }
    nodes.push({
      id: c.id,
      type: "milestone",
      position: { x: c.x ?? 0, y: c.y ?? 0 },
      width: c.width ?? 0,
      height: c.height ?? 0,
      selectable: false,
      focusable: false,
      data: { milestone, title: null, nodes: byMilestone.get(milestone) ?? [], status: null },
    });
    for (const s of inner.get(milestone)?.children ?? []) nodes.push(step(s, c.id));
  }
  return {
    nodes,
    edges: edges.map((e) => ({ id: `${e.from}>${e.to}`, source: e.from, target: e.to, type: "smoothstep" })),
    width: graph.width ?? 0,
    height: graph.height ?? 0,
  };
}

/** Where a node sits on the canvas, adding its milestone box's offset to a step inside one. */
export function absolutePosition(nodes: GraphNode[], id: string): { x: number; y: number } | null {
  const n = nodes.find((x) => x.id === id);
  if (!n) return null;
  const parent = n.parentId ? absolutePosition(nodes, n.parentId) : { x: 0, y: 0 };
  return parent && { x: parent.x + n.position.x, y: parent.y + n.position.y };
}
