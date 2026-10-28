/** Why a role stopped without finishing (spec 2.0 decision 3); the machine maps each to a transition. */
export const BLOCKED_REASONS = [
  "needs_user",
  "too_hard",
  "provider_error",
  "no_access",
  "check_broken",
  "out_of_scope",
  /** plan 48, spec D10: the task cannot be done at all */
  "impossible",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/** The reasons a role may give; `out_of_scope` stays in BLOCKED_REASONS only so old runs replay (plan 45). */
export const STOP_REASONS = [
  "needs_user",
  "too_hard",
  "provider_error",
  "no_access",
  "check_broken",
] as const;

const REASON_AT_START = /^[`*\s]*([a-z][a-z_-]*)[`*]*\s*(?:[:—–-]\s*)?([\s\S]*)$/i;

/** The reason a `STATUS: blocked — <reason>: <why>` line names, and its why; null when it names none. */
export function parseBlockedReason(why: string | null): { reason: BlockedReason; why: string } | null {
  const m = why === null ? null : REASON_AT_START.exec(why.trim());
  if (!m) return null;
  const word = (m[1] as string).toLowerCase().replace(/-/g, "_");
  // `impossible` is the role's own word for the architect (plan 48); the stop classifier never offers it
  const reason = [...STOP_REASONS, "impossible" as const].find((r) => r === word);
  return reason ? { reason, why: (m[2] ?? "").trim() } : null;
}

/** The reply contract's blocked line, ported from t3herd `prompts/_no_questions.md`. */
export const BLOCKED_LINE = `Nobody reads your thread until you finish: never ask a question and never wait for an answer. When you cannot finish, leave the finished work in place, say what is left, and end with STATUS: blocked — <reason>: <why>, where <reason> is one of: ${[
  "needs_user (only the user can decide; <why> is the question)",
  "too_hard (you tried and cannot solve it; a stronger model should)",
  "provider_error (your model, tools or sandbox failed)",
  "no_access (you cannot reach what you need: the running app, a service, credentials)",
  "check_broken (the check cannot pass for a reason outside your task, such as a sibling's code that is not there yet; name each failing file:line)",
  "impossible (the task cannot be done at all: <why> says what stands in the way)",
].join(", ")}.`;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** An `Owns:` entry as a path: cut at the first glob, trailing slashes dropped. */
const pathOf = (entry: string): string => entry.replace(/[*?[{].*$/, "").replace(/\/+$/, "");

/** Whether the output (passing lines dropped) names a path by a tail of at least `min` segments. */
function namer(log: string): (p: string, min: number) => boolean {
  const lines = log
    .replace(ANSI, "")
    .split("\n")
    .filter((l) => !/^\s*(✓|ok\s|PASS\b)/.test(l));
  return (p, min) => {
    const parts = p.split("/");
    for (let i = 0; i <= parts.length - min; i++) {
      const tail = parts.slice(i).join("/");
      if (lines.some((l) => l.includes(tail))) return true;
    }
    return false;
  };
}

/**
 * The sibling `Owns:` entries a failed check blames, or [] when it blames none, or also blames one of the lane's
 * own. Output names a file by its tail (`pkg/x.go:3`, `src/a.tsx(4,2)`), so a sibling's entry counts from two
 * path segments, and an own entry already from its base name (t3herd `foreignFailure`).
 */
export function foreignFailure(log: string, own: string[], siblings: string[]): string[] {
  const named = namer(log);
  const mine = own.map(pathOf).filter(Boolean);
  if (mine.some((f) => named(f, 1))) return [];
  const theirs = siblings.map(pathOf).filter((f) => f && !mine.includes(f));
  return [...new Set(theirs.filter((f) => named(f, Math.min(2, f.split("/").length))))];
}

/** The sibling lane ids whose `Owns:` entries the output names by the same tail rule, even beside an own file. */
export function siblingLanesNamed(log: string, siblings: { id: string; owns: string[] }[]): string[] {
  const named = namer(log);
  return siblings
    .filter((s) => s.owns.map(pathOf).some((f) => f && named(f, Math.min(2, f.split("/").length))))
    .map((s) => s.id);
}
