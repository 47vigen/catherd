import { CatherdError } from "./errors.ts";

export const KINDS = ["repo_code", "terminal", "ui", "prose", "research"] as const;
export type Kind = (typeof KINDS)[number];
export const DIFFICULTIES = ["copy", "build", "logic", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface LaneHeader {
  title: string | null;
  owns: string[];
  fastCheck: string | null;
  kind: Kind | null;
  difficulty: Difficulty | null;
}

const unquote = (s: string) =>
  s
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim();

/** The value of the first `Label:` line, allowing `**Label:**` and `_Label_:` emphasis. */
function field(text: string, label: string): string | null {
  const re = new RegExp(`^\\s*[*_]*${label}[*_]*\\s*:[*_]*\\s*(.*)$`, "i");
  for (const line of text.split("\n")) {
    const m = re.exec(line);
    if (m) return (m[1] ?? "").trim();
  }
  return null;
}

const oneOf = <T extends string>(v: string | null, options: readonly T[]): T | null =>
  v !== null && (options as readonly string[]).includes(unquote(v)) ? (unquote(v) as T) : null;

/** Canonical form: no "." or empty segments, a trailing "/" kept as a directory marker. */
export function normalizeOwned(p: string): string {
  const s = unquote(p);
  const parts = s.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (s.startsWith("/") || parts.length === 0 || parts.includes(".."))
    throw new CatherdError(
      "E_LANE_INVALID",
      `owned path "${p}" must be relative to the repo and stay inside it`,
      {
        fix: "write Owns: paths like src/foo/ or src/bar.ts",
      },
    );
  return parts.join("/") + (s.endsWith("/") ? "/" : "");
}

export function parseLaneHeader(text: string): LaneHeader {
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const owns = (field(text, "owns") ?? "").split(",").map(unquote).filter(Boolean).map(normalizeOwned);
  const check = field(text, "fast check");
  return {
    title,
    owns,
    fastCheck: check ? unquote(check) || null : null,
    kind: oneOf(field(text, "kind"), KINDS),
    difficulty: oneOf(field(text, "difficulty"), DIFFICULTIES),
  };
}

const bare = (p: string) => p.replace(/\/+$/, "");
const covers = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`);

/** The entries of `a` that overlap any entry of `b`; a path covers everything under it. */
export function overlaps(a: string[], b: string[]): string[] {
  return a.filter((x) => b.some((y) => covers(bare(x), bare(y)) || covers(bare(y), bare(x))));
}
