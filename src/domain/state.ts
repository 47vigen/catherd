const PARKED = /^parked: [^;]*; /;

/**
 * Spec 1.1 §8: `next` with the parked milestones in front of it, once ("parked: M2 waits on the owner;
 * <next>"), whoever wrote the step: a milestone stays parked in state.md until it is answered.
 */
export function withParked(next: string, parked: string[]): string {
  const base = next.replace(PARKED, "");
  if (parked.length === 0) return base;
  return `parked: ${parked.join(", ")} ${parked.length > 1 ? "wait" : "waits"} on the owner; ${base}`;
}

export interface StateView {
  title: string;
  head: string;
  dirty: { path: string; owner: string | null }[];
  running: { name: string; rung: string; thread: string | null; since: string; brief: string }[];
  lastCheck: string | null;
  next: string;
}

/** state.md: enough for a fresh session to resume from alone; the next step is always the last line. */
export function renderState(s: StateView): string {
  const waiting = s.running.map((r) => r.name);
  return [
    `# ${s.title}`,
    "",
    `HEAD ${s.head}`,
    "",
    "Dirty:",
    ...(s.dirty.length ? s.dirty.map((d) => `- ${d.path}${d.owner ? ` (${d.owner})` : ""}`) : ["- none"]),
    "",
    "Running:",
    ...(s.running.length
      ? s.running.map(
          (r) => `- ${r.name} · ${r.rung} · thread ${r.thread ?? "new"} · since ${r.since} · ${r.brief}`,
        )
      : ["- none"]),
    "",
    `Last check: ${s.lastCheck ?? "none"}`,
    "",
    // 1.1: no tool waits; each running role's record arrives as a catherd message
    `Next: ${waiting.length ? `running ${waiting.join(", ")} (results arrive as catherd messages; peek to check); then ${s.next}` : s.next}`,
    "",
  ].join("\n");
}
