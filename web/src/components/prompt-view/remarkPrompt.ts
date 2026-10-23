import { tokenize } from "./tokens";

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };

/** Leaves whose text the plugin must not touch: code stays as written. */
const LEAF = new Set(["code", "inlineCode", "math", "inlineMath"]);

/**
 * A remark plugin for prompt prose. Inline HTML is read as text first (`<the conflict>` is a placeholder, not an
 * element), then placeholders, tool names, commands and reply keywords become inline code marked `data-token`.
 */
export function remarkPrompt() {
  return (tree: Node) => walk(tree);
}

function walk(node: Node): void {
  if (!node.children || LEAF.has(node.type)) return;
  const merged: Node[] = [];
  for (const raw of node.children) {
    const child: Node =
      raw.type === "html"
        ? node.type === "root"
          ? { type: "paragraph", children: [{ type: "text", value: raw.value ?? "" }] }
          : { type: "text", value: raw.value ?? "" }
        : raw;
    const last = merged.at(-1);
    if (child.type === "text" && last?.type === "text") last.value = (last.value ?? "") + child.value;
    else merged.push(child.type === "text" ? { ...child } : child);
  }
  node.children = merged.flatMap((c) =>
    c.type === "text"
      ? tokenize(c.value ?? "").map((t) =>
          t.kind === "text"
            ? { type: "text", value: t.value }
            : { type: "inlineCode", value: t.value, data: { hProperties: { "data-token": t.kind } } },
        )
      : [c],
  );
  for (const c of node.children) walk(c);
}
