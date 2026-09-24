import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Difficulty, Kind, Role, RungId } from "../types.ts";
import { appendJsonl, readJsonl } from "./runstore.ts";

/** Ids of runs, roles and lanes end up in file names, so they never hold a separator or start with a dot. */
export const ID = /^[A-Za-z0-9][\w.-]*$/;

export function ownedFilesOf(laneText: string): string[] {
  for (const line of laneText.split("\n")) {
    const m = /^\s*[*_]*owns[*_]*\s*:[*_]*\s*(.*)$/i.exec(line);
    if (m) {
      return (m[1] ?? "")
        .split(",")
        .map((s) => s.trim().replace(/^`+|`+$/g, ""))
        .filter(Boolean);
    }
  }
  return [];
}

export function readLane(runDir: string, lane: string): string {
  if (!ID.test(lane)) throw new Error(`catherd: bad lane id "${lane}"`);
  const file = join(runDir, "lanes", `${lane}.md`);
  if (!existsSync(file))
    throw new Error(`catherd: no lane file lanes/${lane}.md; write it with write_run_file first`);
  return readFileSync(file, "utf8");
}

export const CLIMB_REASONS = [
  "check-failed-twice",
  "blocker",
  "same-defect",
  "refused",
  "blocked",
  "unchanged",
] as const;
export type ClimbReason = (typeof CLIMB_REASONS)[number];

export interface LaneRoute {
  at: string;
  lane: string;
  role: Role;
  rung: RungId;
  ladder: RungId[];
  source: "route" | "climb";
  from: RungId | null;
  reason: string | null;
  kind: Kind | null;
  difficulty: Difficulty | null;
  jev: "jev" | "default";
}

const routesFile = (runDir: string) => join(runDir, "routes.jsonl");

export const appendRoute = (runDir: string, r: LaneRoute): void => appendJsonl(routesFile(runDir), r);
export const readRoutes = (runDir: string): LaneRoute[] => readJsonl<LaneRoute>(routesFile(runDir));
export const currentRoute = (runDir: string, lane: string): LaneRoute | undefined =>
  readRoutes(runDir).findLast((r) => r.lane === lane);
