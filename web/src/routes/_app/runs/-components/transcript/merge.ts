import type { TranscriptItem } from "../../../../../client";

/** What the view draws: every item kind but `output`, which only fills the card with its id. */
export type Card = Exclude<TranscriptItem, { kind: "output" }>;

const idOf = (c: { kind: string }): string | undefined => ("id" in c ? String(c.id) : undefined);

/**
 * Folds new items into the cards already held. An item with the id of a held card replaces it in place; an `output`
 * fills the `output` (and a tool's `error`) of its card; a `thinking` step with no text is dropped. Returns a new array.
 */
export function mergeTranscript(cards: Card[], items: TranscriptItem[]): Card[] {
  const next = [...cards];
  for (const item of items) {
    if (item.kind === "thinking" && !item.text.trim()) continue;
    if (item.kind === "output") {
      const at = next.findIndex((c) => (c.kind === "tool" || c.kind === "shell") && c.id === item.id);
      const card = next[at];
      if (card?.kind === "tool") next[at] = { ...card, output: item.text, error: item.error };
      else if (card?.kind === "shell") next[at] = { ...card, output: item.text };
      continue;
    }
    const id = idOf(item);
    const at = id === undefined ? -1 : next.findIndex((c) => c.kind === item.kind && idOf(c) === id);
    if (at >= 0) next[at] = item;
    else next.push(item);
  }
  return next;
}

/** The text a search matches against. */
export function cardText(c: Card): string {
  switch (c.kind) {
    case "text":
    case "thinking":
    case "error":
    case "raw":
      return c.text;
    case "tool":
      return [c.name, c.input, c.output ?? ""].join("\n");
    case "shell":
      return [c.command, c.output ?? ""].join("\n");
    case "file":
      return [...c.changes.map((x) => x.path), c.diff ?? ""].join("\n");
    case "turn":
      return "";
  }
}
