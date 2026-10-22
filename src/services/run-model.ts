import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CatherdError } from "../domain/errors.ts";
import { deriveRunModel, nodeForUnit, recordAttempt, type RunModel } from "../domain/run-graph.ts";
import { isDaemonRun, readEvents } from "./run-events-store.ts";
import { replay } from "../domain/run-state.ts";
import { findRun, readRecords } from "./run-store.ts";

/** A reply is cut here when it is shown beside a question. */
const REPLY_LIMIT = 64 * 1024;

/** The run's model; a 1.5 run has no events, so it has no nodes and lists its dispatch records. */
export function runModel(runId: string): RunModel {
  const run = findRun(runId);
  const { records } = readRecords(run);
  if (!isDaemonRun(run))
    return {
      run: run.id,
      engine: "1.5",
      seq: 0,
      phase: null,
      outcome: null,
      nodes: [],
      edges: [],
      dispatches: records.map(recordAttempt).sort((a, b) => b.at.localeCompare(a.at)),
    };
  const events = readEvents(run);
  return deriveRunModel({ run: run.id, state: replay(events, run.id), events, records });
}

export const QuestionContextSchema = z.object({
  node: z.string(),
  /** the asking role's latest reply.md, cut at 64 KB */
  reply: z.string().nullable(),
  replyName: z.string().nullable(),
  lane: z.string().nullable(),
});
export type QuestionContext = z.infer<typeof QuestionContextSchema>;

/** First bytes of a file as text; null when it cannot be read. */
function head(file: string): string | null {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(REPLY_LIMIT);
      return buf.toString("utf8", 0, readSync(fd, buf, 0, REPLY_LIMIT, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Where an open question sits in the graph and what the role that asked it last said. */
export function questionContext(runId: string, unit: string): QuestionContext {
  const run = findRun(runId);
  const events = readEvents(run);
  const state = replay(events, run.id);
  const q = state.questions[unit];
  if (!q)
    throw new CatherdError("E_INPUT_INVALID", `${unit} has no open question`, { fix: "status() lists them" });
  const { records } = readRecords(run);
  const model = deriveRunModel({ run: run.id, state, events, records });
  const at = nodeForUnit(state, unit, q.reason);
  const found = model.nodes.find((n) => n.id === at) ?? model.nodes.find((n) => n.id === "start");
  const asked = found?.attempts.find((a) => a.kind === "dispatch");
  const record = records.find((r) => r.dispatchId === asked?.dispatchId);
  const reply = record ? head(join(run.dir, record.replyPath)) : null;
  return {
    node: found?.id ?? "start",
    reply,
    replyName: reply === null ? null : (asked?.name ?? null),
    lane: found?.lane ?? null,
  };
}
