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
    `Next: ${waiting.length ? `wait for ${waiting.join(", ")}; then ${s.next}` : s.next}`,
    "",
  ].join("\n");
}
