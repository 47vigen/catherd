import type { Edge, Node } from "@xyflow/react";

import type { RunModel, RunNode } from "../../../../client";

export const NODE_WIDTH = 232;
export const NODE_HEIGHT = 84;

export const ELK_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.spacing.nodeNode": "24",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
};

export type StepNode = Node<{ node: RunNode; now: number; onOpen?: (id: string) => void }, "step">;

/** The shape of the graph: node ids and edges only, so a status change never lays the run out again. */
export const layoutKey = (m: RunModel): string =>
  JSON.stringify([m.nodes.map((n) => n.id), m.edges.map((e) => `${e.from}>${e.to}`)]);

// elkjs is large (1.5 MB): it loads when the first graph needs it, so the page shows its header first.
const elk = import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());

export async function layoutRunModel(model: RunModel): Promise<{ nodes: StepNode[]; edges: Edge[] }> {
  const ids = new Set(model.nodes.map((n) => n.id));
  const edges = model.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const graph = await (
    await elk
  ).layout({
    id: "run",
    layoutOptions: ELK_OPTIONS,
    children: model.nodes.map((n) => ({ id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: edges.map((e) => ({ id: `${e.from}>${e.to}`, sources: [e.from], targets: [e.to] })),
  });
  const at = new Map((graph.children ?? []).map((c) => [c.id, c]));
  return {
    nodes: model.nodes.map((n) => ({
      id: n.id,
      type: "step",
      position: { x: at.get(n.id)?.x ?? 0, y: at.get(n.id)?.y ?? 0 },
      // Fixed size: React Flow draws the node at once instead of waiting to measure it.
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: { node: n, now: 0 },
    })),
    edges: edges.map((e) => ({ id: `${e.from}>${e.to}`, source: e.from, target: e.to, type: "smoothstep" })),
  };
}
