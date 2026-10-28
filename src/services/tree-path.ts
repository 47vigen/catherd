import type { Run } from "./run-store.ts";

/** The compose project of a base run's tree (`-base` for its baseline tree): one stack per tree. */
export const composeProjectOf = (run: Run, baseline = false): string | null =>
  run.meta.base ? `catherd-${run.id.slice(0, 15).replace("-", "")}${baseline ? "-base" : ""}` : null;
