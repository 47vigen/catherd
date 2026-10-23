/** A piece of prompt prose: plain text, or a span the view marks up. */
export type Token = { kind: "text" | "placeholder" | "tool" | "command" | "keyword"; value: string };

const PLACEHOLDER = String.raw`<(?!\/)[^<>\n]{1,80}>`;
const ARG = String.raw`(?:${PLACEHOLDER}|--?[\w-]*|[A-Z]{2,}\b|[\w@/.-]*[\d@/_][\w@/.-]*|lock|read|write|show)`;
const HEAD = String.raw`\b(?:catherd (?:run-file (?:read|write)|knowledge show|gate (?:run|pass|check)|lock)|bunx [\w@/.-]+|git (?:diff|rev-parse|archive|log|show))`;

const TOKEN = new RegExp(
  [
    String.raw`(?<command>${HEAD}(?: ${ARG})*)`,
    String.raw`(?<tool>\bmcp__\w+(?:<[^<>\s]+>)?|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b)`,
    String.raw`(?<keyword>(?<![$\w])[A-Z][A-Z_]+:(?=\s|$))`,
    String.raw`(?<placeholder>${PLACEHOLDER})`,
  ].join("|"),
  "g",
);

/** Splits prose into text and the spans a prompt is made of: placeholders, tool names, commands, reply keywords. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    const kind = (Object.keys(m.groups!) as Token["kind"][]).find((k) => m.groups![k] !== undefined)!;
    // A command ends a sentence often; its full stop is the sentence's, not the command's.
    const value = kind === "command" ? m[0].replace(/\.+$/, "") : m[0];
    if (m.index > at) out.push({ kind: "text", value: text.slice(at, m.index) });
    out.push({ kind, value });
    at = m.index + value.length;
  }
  if (at < text.length) out.push({ kind: "text", value: text.slice(at) });
  return out;
}

/** Splits code into its literal parts and its `<placeholder>`s. */
export const splitPlaceholders = (code: string): { hole: boolean; value: string }[] =>
  code
    .split(new RegExp(`(${PLACEHOLDER})`))
    .filter(Boolean)
    .map((value) => ({ hole: new RegExp(`^${PLACEHOLDER}$`).test(value), value }));
