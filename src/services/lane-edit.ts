import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { assertId } from "../domain/ids.ts";
import {
  assertLaneValues,
  type LaneHeader,
  normalizeOwned,
  overlaps,
  parseLaneHeader,
} from "../domain/lane.ts";
import { cell } from "../domain/util.ts";
import { withFileLock } from "../infra/filelock.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { pendingDispatches } from "./dispatches.ts";
import type { Deps } from "./ports.ts";
import { findRun, type Run, runPaths } from "./run-store.ts";

/** lanes/<lane>.md in the run folder (admission's laneFile, kept here so finalize can import this module). */
const laneFile = (run: Run, lane: string): string => join(runPaths(run.dir).lanes, `${lane}.md`);

// Spec 1.5 "Lane editing": one header line at a time, validated, instead of `sed` on the run folder; and an
// Owns list that can grow mid-lane, with the overlap re-checked.

/** The header lines lane_set writes, and their labels in the lane file. */
export const LANE_FIELDS = {
  owns: "Owns",
  fast_check: "Fast check",
  kind: "Kind",
  difficulty: "Difficulty",
  after: "After",
  allow: "Allow",
} as const;
export type LaneField = keyof typeof LANE_FIELDS;

/** `label`'s first header line, as parseLaneHeader reads it (`**Label:**` and `_Label_:` included). */
const lineOf = (label: string) => new RegExp(`^\\s*[*_]*${label}[*_]*\\s*:.*$`, "im");

/** `text` with `label`'s line set to `value`: replaced where it is, else added under the title. */
export function setHeaderLine(text: string, label: string, value: string): string {
  const line = `${label}: ${value}`;
  if (lineOf(label).test(text)) return text.replace(lineOf(label), line);
  const lines = text.split("\n");
  const title = lines.findIndex((l) => /^#\s+/.test(l));
  lines.splice(title + 1, 0, line);
  return lines.join("\n");
}

function readLane(run: Run, lane: string): { file: string; text: string } {
  assertId("lane", lane);
  const file = laneFile(run, lane);
  if (!existsSync(file))
    throw new CatherdError("E_LANE_INVALID", `no lane file lanes/${lane}.md`, {
      fix: "write it with write_run_file first",
    });
  return { file, text: readFileSync(file, "utf8") };
}

/**
 * Paths of `owns` another running lane owns: refused as admission refuses them. Other lanes' Owns lines
 * that overlap come back as hints: they are not running, so nothing collides yet.
 */
function overlapCheck(deps: Deps, run: Run, lane: string, owns: string[]): string[] {
  for (const d of pendingDispatches(run, deps.now())) {
    if (d.admit.lane === lane) continue;
    const shared = overlaps(owns, d.admit.owns);
    if (shared.length)
      throw new CatherdError(
        "E_ADMIT_OVERLAP",
        `${lane} would own ${shared.join(", ")}, which ${d.admit.name} (running) owns`,
        { fix: `add it once ${d.admit.name} finishes, or give the work to ${d.admit.lane ?? d.admit.name}` },
      );
  }
  const dir = runPaths(run.dir).lanes;
  const hints: string[] = [];
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const other = f.endsWith(".md") ? f.slice(0, -3) : null;
    if (!other || other === lane) continue;
    try {
      const shared = overlaps(owns, parseLaneHeader(readFileSync(join(dir, f), "utf8")).owns);
      if (shared.length) hints.push(`lanes/${f} also owns ${shared.join(", ")}: do not run the two together`);
    } catch {
      // an unreadable lane is preflight's to report
    }
  }
  return hints;
}

/**
 * `lane_set(run, lane, field, value)`: one header line, validated as `write_run_file` validates a lane; an
 * Owns line also re-checks overlap with the running lanes. Returns the line and the header as it now reads.
 */
export async function laneSet(
  deps: Deps,
  i: { run: string; lane: string; field: LaneField; value: string },
): Promise<{ lane: string; line: string; header: LaneHeader; hints?: string[] }> {
  const run = findRun(i.run);
  const label = LANE_FIELDS[i.field];
  if (!label)
    throw new CatherdError("E_INPUT_INVALID", `no lane field "${i.field}"`, {
      fix: `one of ${Object.keys(LANE_FIELDS).join(", ")}`,
    });
  const value = i.value.replace(/\s*\n\s*/g, " ").trim();
  const { file } = readLane(run, i.lane);
  return withFileLock(file, () => {
    const next = setHeaderLine(readLane(run, i.lane).text, label, value);
    const header = assertLaneValues(next, `lanes/${i.lane}.md`);
    const hints = i.field === "owns" ? overlapCheck(deps, run, i.lane, header.owns) : [];
    writeTextAtomic(file, next);
    return { lane: i.lane, line: `${label}: ${value}`, header, ...(hints.length ? { hints } : {}) };
  });
}

/**
 * `owns_add(run, lane, paths, why)`: grows a lane's Owns mid-lane (a test file the plan's grep missed, a clone
 * found after the gate ran), refused when a running lane owns one of them. The why is kept in the lane file.
 * A running dispatch of the lane is held to the new list when it finishes.
 */
export async function ownsAdd(
  deps: Deps,
  i: { run: string; lane: string; paths: string[]; why: string },
): Promise<{ lane: string; owns: string[]; added: string[]; hints?: string[] }> {
  const run = findRun(i.run);
  if (!i.why.trim())
    throw new CatherdError("E_INPUT_INVALID", "owns_add needs a why", {
      fix: "say what made the lane need the paths, in one line",
    });
  const paths = i.paths.map(normalizeOwned);
  const { file } = readLane(run, i.lane);
  return withFileLock(file, () => {
    const text = readLane(run, i.lane).text;
    const owns = parseLaneHeader(text).owns;
    const added = paths.filter((p) => !owns.includes(p));
    const merged = [...owns, ...added];
    const hints = overlapCheck(deps, run, i.lane, added);
    const note = `\nOwns added ${new Date(deps.now()).toISOString()}: ${added.join(", ")} — ${cell(i.why)}\n`;
    const next = setHeaderLine(text, "Owns", merged.join(", "));
    assertLaneValues(next, `lanes/${i.lane}.md`);
    if (added.length) writeTextAtomic(file, `${next.replace(/\n*$/, "\n")}${note}`);
    return { lane: i.lane, owns: merged, added, ...(hints.length ? { hints } : {}) };
  });
}

/** The lane's Owns as its file reads now: a finishing dispatch is held to what owns_add granted since. */
export function currentOwns(run: Run, lane: string): string[] {
  try {
    return parseLaneHeader(readFileSync(laneFile(run, lane), "utf8")).owns;
  } catch {
    return [];
  }
}
