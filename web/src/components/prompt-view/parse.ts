/** A prompt read as a tree: block-level XML-style tags around markdown text. */
export type PromptNode = PromptTag | PromptText;
export type PromptTag = {
  kind: "tag";
  name: string;
  attrs: Record<string, string>;
  children: PromptNode[];
  /** Opened but never closed (a cut-off prompt): it runs to the end of its parent. */
  unclosed?: boolean;
};
export type PromptText = { kind: "text"; text: string };

const OPEN = /^<([a-zA-Z][\w-]*)((?:\s+[\w:.-]+=(?:"[^"]*"|'[^']*'))*)\s*>$/;
const CLOSE = /^<\/([a-zA-Z][\w-]*)\s*>$/;
const INLINE = /^<([a-zA-Z][\w-]*)((?:\s+[\w:.-]+=(?:"[^"]*"|'[^']*'))*)\s*>(.*)<\/\1\s*>$/;
const ATTR = /([\w:.-]+)=(?:"([^"]*)"|'([^']*)')/g;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** Section tags catherd writes: one of these left open (a cut-off prompt) still frames what follows it. */
const KNOWN = new Set(["role", "team", "context", "task", "done_when", "reply_contract", "plan-task", "lane-file"]);

const attrsOf = (s: string): Record<string, string> =>
  Object.fromEntries([...s.matchAll(ATTR)].map((m) => [m[1]!, m[2] ?? m[3] ?? ""]));

/**
 * Parses a prompt into tags and text. A tag counts only when its opening line holds nothing but the tag and a
 * matching closing line follows (or it opens and closes on one line); `<run>` or `<the conflict>` inside prose,
 * stray closers and tags inside code fences stay text.
 */
export function parsePrompt(source: string): PromptNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const fenced: boolean[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (fence) {
      fenced.push(true);
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && !line.trim().slice(m[1]!.length)) {
        fence = undefined;
      }
    } else {
      fenced.push(Boolean(m));
      if (m) fence = m[1];
    }
  }
  const open = (i: number) => (fenced[i] ? null : OPEN.exec(lines[i]!.trim()));
  const close = (i: number) => (fenced[i] ? null : CLOSE.exec(lines[i]!.trim())?.[1]);

  /** The closing line of the tag opened at `at`, counting nested tags of the same name, before `end`. */
  const closer = (at: number, name: string, end: number): number => {
    let depth = 0;
    for (let i = at + 1; i < end; i++) {
      if (open(i)?.[1] === name) depth++;
      else if (close(i) === name && depth-- === 0) return i;
    }
    return -1;
  };

  const build = (from: number, end: number): PromptNode[] => {
    const out: PromptNode[] = [];
    let text: string[] = [];
    const flush = () => {
      const body = text
        .join("\n")
        .replace(/^\s*\n/, "")
        .trimEnd();
      if (body.trim()) out.push({ kind: "text", text: body });
      text = [];
    };
    for (let i = from; i < end; i++) {
      const line = lines[i]!;
      const inline = fenced[i] ? null : INLINE.exec(line.trim());
      if (inline) {
        flush();
        const body = inline[3]!.trim();
        out.push({
          kind: "tag",
          name: inline[1]!,
          attrs: attrsOf(inline[2]!),
          children: body ? [{ kind: "text", text: body }] : [],
        });
        continue;
      }
      const m = open(i);
      if (m) {
        const j = closer(i, m[1]!, end);
        if (j >= 0 || KNOWN.has(m[1]!)) {
          flush();
          const stop = j >= 0 ? j : end;
          out.push({
            kind: "tag",
            name: m[1]!,
            attrs: attrsOf(m[2]!),
            children: build(i + 1, stop),
            ...(j < 0 && { unclosed: true }),
          });
          i = stop;
          continue;
        }
      }
      text.push(line);
    }
    flush();
    return out;
  };
  return build(0, lines.length);
}

/** Words in a node, for the outline's sizes. */
export const wordCount = (nodes: PromptNode[]): number =>
  nodes.reduce((n, c) => n + (c.kind === "text" ? (c.text.match(/\S+/g)?.length ?? 0) : wordCount(c.children)), 0);
