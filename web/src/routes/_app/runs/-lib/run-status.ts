import type { RunView } from "../../../../client";
import type { Status } from "../../../../components/status-chip/StatusChip";

/** What a run is doing: a 1.5 run is only informational, an outcome ends the story, a parked unit comes next. */
export function runStatus(r: RunView): Status {
  if (r.engine === "1.5") return "info";
  if (r.outcome) return r.outcome;
  if (r.parked.length > 0) return "parked";
  return r.phase === "planning" || r.phase === "approval" ? r.phase : "running";
}

export const daemonStatus = (r: RunView): Status => (r.daemon.alive ? "alive" : "dead");
