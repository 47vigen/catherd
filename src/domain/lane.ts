import { CatherdError } from "./errors.ts";
import { TASK_REF } from "./plan-doc.ts";

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
  /** `After: M1.L1, M1.L2`: lanes that must finish first (protocol.next and admission keep the order) */
  after: string[];
  /** `Allow: path[:line], …` under the check: hits of the lane's absence check that are allowed exceptions */
  allow: string[];
  /** `Tasks: 3, plan.md#4`: the plan tasks the lane implements (catherd inlines them into its worker's brief) */
  tasks: string[];
  /** `Chore: yes`: routing starts the lane on the cheapest capable rung */
  chore: boolean;
}

/** An After: entry: a lane id (Mx.Ly, the shape lanes/<id>.md takes) or a whole milestone (Mx). */
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

/** An Allow: entry: a repo-relative path, optionally `:<line>`. */
const ALLOW_ENTRY = /^([^\s:]+)(?::(\d+))?$/;

const unquote = (s: string) =>
  s
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim();

/**
 * The lane's header block, as [start, end) line indexes: the lines under the `# ` title (blank lines right
 * after it skipped) up to the first blank line or heading. Header lines are read only here, so a body's prose
 * (`After: the handler returns 404`) is never a header value.
 */
export function headerBlock(lines: string[]): [number, number] {
  const title = lines.findIndex((l) => /^#\s+/.test(l));
  let start = title + 1;
  while (start < lines.length && (lines[start] ?? "").trim() === "") start++;
  let end = start;
  while (end < lines.length && (lines[end] ?? "").trim() !== "" && !(lines[end] ?? "").startsWith("#")) end++;
  return [start, end];
}

/** A header line `Label:`, allowing `**Label:**` and `_Label_:` emphasis; group 1 is its value. */
export const headerLine = (label: string) => new RegExp(`^\\s*[*_]*${label}[*_]*\\s*:[*_]*\\s*(.*)$`, "i");

/** The value of the first `Label:` line of the header block. */
function field(text: string, label: string): string | null {
  const re = headerLine(label);
  const lines = text.split("\n");
  const [start, end] = headerBlock(lines);
  for (const line of lines.slice(start, end)) {
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

const CHORE_VALUES = ["yes", "no"] as const;

export function parseLaneHeader(text: string): LaneHeader {
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const owns = (field(text, "owns") ?? "").split(",").map(unquote).filter(Boolean).map(normalizeOwned);
  const check = field(text, "fast check");
  const list = (label: string) => (field(text, label) ?? "").split(",").map(unquote).filter(Boolean);
  return {
    title,
    owns,
    fastCheck: check ? unquote(check) || null : null,
    kind: oneOf(field(text, "kind"), KINDS),
    difficulty: oneOf(field(text, "difficulty"), DIFFICULTIES),
    after: list("after"),
    allow: list("allow"),
    tasks: list("tasks"),
    chore: oneOf(field(text, "chore"), CHORE_VALUES) === "yes",
  };
}

/** The milestones, other than `m`, that `m`'s lanes wait on (After: entries, lane or milestone), in numeric order. */
export function milestoneAfter(lanes: { id: string; after: string[] }[], m: string): string[] {
  const out = new Set<string>();
  for (const l of lanes)
    if (l.id.split(".")[0] === m)
      for (const a of l.after) {
        const dep = a.split(".")[0] as string;
        if (dep !== m) out.add(dep);
      }
  return [...out].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** A Chore: value other than yes or no; none when the line is absent. */
function choreProblems(text: string): string[] {
  const v = field(text, "chore");
  return v !== null && oneOf(v, CHORE_VALUES) === null ? [`Chore "${unquote(v)}" is not yes or no`] : [];
}

/** What is wrong with the After: and Allow: entries, one line each; none when they are well formed. */
function orderProblems(h: LaneHeader): string[] {
  const out: string[] = [];
  for (const a of h.after)
    if (!LANE_ID.test(a)) out.push(`After "${a}" is not a lane or milestone id like M1.L1 or M1`);
  for (const t of h.tasks)
    if (!TASK_REF.test(t)) out.push(`Tasks "${t}" is not a task number like 3 or plan.md#3`);
  for (const a of h.allow) {
    const m = ALLOW_ENTRY.exec(a);
    try {
      if (!m) throw new Error();
      normalizeOwned(m[1] as string);
    } catch {
      out.push(`Allow "${a}" is not a repo path, or path:line`);
    }
  }
  return out;
}

/**
 * Spec 1.5 "Lane editing": `write_run_file` refuses a lane whose header values are present but wrong (a Kind
 * or Difficulty the catalog does not know, an Owns path that leaves the repo, a malformed After: or Allow:),
 * so a typo is caught when the lane is written, not at preflight. A missing line is left to routing.
 */
export function assertLaneValues(text: string, where: string): LaneHeader {
  let h: LaneHeader;
  try {
    h = parseLaneHeader(text);
  } catch (e) {
    throw new CatherdError("E_LANE_INVALID", `${where}: ${(e as Error).message}`, {
      fix: "write Owns: paths like src/foo/ or src/bar.ts",
    });
  }
  const problems: string[] = [];
  const kind = field(text, "kind");
  const difficulty = field(text, "difficulty");
  if (kind !== null && h.kind === null) problems.push(`Kind "${unquote(kind)}" is not one the catalog knows`);
  if (difficulty !== null && h.difficulty === null)
    problems.push(`Difficulty "${unquote(difficulty)}" is not one the catalog knows`);
  problems.push(...choreProblems(text));
  problems.push(...orderProblems(h));
  if (problems.length)
    throw new CatherdError("E_LANE_INVALID", `${where}: ${problems.join("; ")}`, {
      fix: `${LANE_HEADER_FIX}; After: M1.L1, M1.L2; Allow: path or path:line`,
    });
  return h;
}

/** A repo path in the form normalizeOwned gives it, or null for one that leaves the repo. */
function repoPath(p: string): string | null {
  try {
    return normalizeOwned(p);
  } catch {
    return null;
  }
}

/**
 * Whether every line a failing check printed is a `path:line` hit its lane allows: an absence check (a grep
 * that must find nothing) whose only hits are the lane's declared exceptions has passed.
 */
export function onlyAllowedHits(lines: string[], allow: string[]): boolean {
  const hits = lines.map((l) => /^([^\s:]+):(\d+)(?::|$)/.exec(l.trim()));
  if (allow.length === 0 || hits.length === 0 || hits.some((m) => !m)) return false;
  return hits.every((m) =>
    allow.some((entry) => {
      const [, path, line] = ALLOW_ENTRY.exec(entry) ?? [];
      if (!path) return false;
      const file = repoPath((m as RegExpExecArray)[1] as string);
      const allowedPath = repoPath(path);
      if (!file || !allowedPath) return false;
      const at = (m as RegExpExecArray)[2];
      const inPath = file === allowedPath || (allowedPath.endsWith("/") && file.startsWith(allowedPath));
      return inPath && (line === undefined || line === at);
    }),
  );
}

/** The fix every lane-header refusal carries: the values the catalog knows. */
export const LANE_HEADER_FIX = `write the lane's header lines as Kind: ${KINDS.join("|")} and Difficulty: ${DIFFICULTIES.join("|")}`;

/**
 * Spec 1.1 §6: a lane's `Kind:` and `Difficulty:` must be values the catalog knows, so routing never falls
 * back on a typo. `where` names the lane file in the message. Throws E_LANE_INVALID; returns the header.
 */
export function assertLaneHeader(text: string, where: string): LaneHeader {
  const h = parseLaneHeader(text);
  const problems: string[] = [];
  const check = (label: string, value: string | null, ok: boolean) => {
    if (ok) return;
    problems.push(
      value === null ? `no ${label}: line` : `${label} "${unquote(value)}" is not one the catalog knows`,
    );
  };
  check("Kind", field(text, "kind"), h.kind !== null);
  check("Difficulty", field(text, "difficulty"), h.difficulty !== null);
  problems.push(...orderProblems(h), ...choreProblems(text));
  if (problems.length)
    throw new CatherdError("E_LANE_INVALID", `${where}: ${problems.join("; ")}`, { fix: LANE_HEADER_FIX });
  return h;
}

const bare = (p: string) => p.replace(/\/+$/, "");
const covers = (outer: string, inner: string) => inner === outer || inner.startsWith(`${outer}/`);

/** The entries of `a` that overlap any entry of `b`; a path covers everything under it. */
export function overlaps(a: string[], b: string[]): string[] {
  return a.filter((x) => b.some((y) => covers(bare(x), bare(y)) || covers(bare(y), bare(x))));
}
