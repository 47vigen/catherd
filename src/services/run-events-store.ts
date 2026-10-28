import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { CatherdError, UPGRADE } from "../domain/errors.ts";
import { EVENTS_SCHEMA, RunEventSchema, type RunEvent, type RunEventInput } from "../domain/run-events.ts";
import { type RunState, replay } from "../domain/run-state.ts";
import { db, ensureRunRow, insertEvent, storeOnFile } from "../infra/db.ts";
import { withFileLock } from "../infra/filelock.ts";
import { log } from "../infra/log.ts";
import { appendJsonlBatch } from "../infra/store.ts";
import type { Run } from "./run-store.ts";

/** What the reads need of a run: its id for messages, its folder for the file. */
type RunRef = Pick<Run, "id" | "dir">;

/** `<run>/events.jsonl`: one fact per line, dense `seq`; the store of a run an earlier 2.0 build started. */
export const eventsFile = (run: RunRef): string => join(run.dir, "events.jsonl");

/** Plan 46: a run keeps its events in the database (D13), unless an earlier build gave it an events.jsonl. */
const onFile = (run: RunRef): boolean => storeOnFile(run, eventsFile(run), "events");

/** A 2.0 run has events; a run without any is a 1.5 run, and the daemon never drives it. */
export const isDaemonRun = (run: RunRef): boolean =>
  onFile(run) || db().query("SELECT 1 FROM events WHERE run_id = ? LIMIT 1").get(run.id) !== null;

const corrupt = (run: RunRef, after: number, why: string): CatherdError =>
  new CatherdError("E_RUN_CORRUPT", `${eventsFile(run)} is corrupt after seq ${after}: ${why}`, {
    fix: `restore events.jsonl from a backup, or finish run ${run.id} with catherd 1.x`,
  });

const tooOld = (run: RunRef, v: unknown): CatherdError =>
  new CatherdError(
    "E_RUNTIME_TOO_OLD",
    `${eventsFile(run)} holds events of version ${String(v)}, newer than this catherd (${EVENTS_SCHEMA})`,
    { fix: `upgrade catherd: ${UPGRADE}` },
  );

/** One line as an event: a newer `v` is too old a catherd, anything else invalid is corrupt (null here). */
function decode(run: RunRef, line: string): RunEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const v = (raw as { v?: unknown } | null)?.v;
  if (typeof v === "number" && v > EVENTS_SCHEMA) throw tooOld(run, v);
  const r = RunEventSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * The run's events from `fromSeq` (1 reads them all and checks every line). A last line without its newline
 * that does not parse is a torn append: skipped and logged. Any other line that does not parse, or a seq that
 * is not the line's number, refuses the read (E_RUN_CORRUPT, naming the seq before it); a newer `v`, too.
 * Lines before `fromSeq` are skipped unread: the caller replayed them already.
 */
export function readEvents(run: RunRef, fromSeq = 1): RunEvent[] {
  if (!onFile(run)) return readRows(run, fromSeq);
  let text: string;
  try {
    text = readFileSync(eventsFile(run), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  if (tail) lines.push(tail);
  const out: RunEvent[] = [];
  for (const [i, line] of lines.entries()) {
    if (i + 1 < fromSeq || !line.trim()) continue;
    const e = decode(run, line);
    if (e === null) {
      if (i === lines.length - 1 && line === tail) {
        log("warn", "events", { run: run.id, torn: i + 1 });
        break;
      }
      throw corrupt(run, i, "a line is not an event");
    }
    if (e.seq !== i + 1) throw corrupt(run, i, `seq ${e.seq} stands where ${i + 1} belongs`);
    out.push(e);
  }
  return out;
}

/** The database's events of `run` from `fromSeq`; a row that is not an event refuses the read (E_RUN_CORRUPT). */
function readRows(run: RunRef, fromSeq: number): RunEvent[] {
  const rows = db()
    .query("SELECT seq, body FROM events WHERE run_id = ? AND seq >= ? ORDER BY seq")
    .all(run.id, fromSeq) as { seq: number; body: string }[];
  const out: RunEvent[] = [];
  for (const r of rows) {
    const e = decode(run, r.body);
    if (e === null) throw corrupt(run, r.seq - 1, "a row is not an event");
    out.push(e);
  }
  return out;
}

/** The last seq written, 0 for none: what a reader compares to see whether the run moved. */
export function lastEventSeq(run: Run): number {
  if (onFile(run)) return lastSeq(run);
  const r = db().query("SELECT MAX(seq) AS seq FROM events WHERE run_id = ?").get(run.id) as {
    seq: number | null;
  };
  return r.seq ?? 0;
}

/** Whether the run's events say it ended (`run.ended`). */
export function hasRunEnded(run: Run): boolean {
  if (!onFile(run))
    return (
      db().query("SELECT 1 FROM events WHERE run_id = ? AND type = 'run.ended' LIMIT 1").get(run.id) !== null
    );
  try {
    // a `"type":"run.ended"` never occurs inside a JSON string
    return readFileSync(eventsFile(run), "utf8").includes('"type":"run.ended"');
  } catch {
    return false;
  }
}

export const replayRun = (run: Run): RunState => replay(readEvents(run), run.id);

/**
 * The last seq of the file. With `repair` (only under the file's lock, before an append) a torn tail is cut off
 * first, so the next line starts clean; a reader never writes.
 */
function lastSeq(run: Run, repair = false): number {
  const file = eventsFile(run);
  if (!existsSync(file)) return 0;
  const fd = openSync(file, repair ? "r+" : "r");
  try {
    const size = fstatSync(fd).size;
    let chunk = 64 * 1024;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      const cut = text.lastIndexOf("\n");
      const tail = text.slice(cut + 1);
      const body = text.slice(0, cut + 1).trimEnd();
      // the whole last complete line is in the chunk, or the chunk is the whole file
      if (start > 0 && !body.includes("\n")) {
        chunk *= 4;
        continue;
      }
      if (repair && tail && decode(run, tail) === null) {
        // a torn append: not an event, never will be one
        ftruncateSync(fd, size - Buffer.byteLength(tail));
        log("warn", "events", { run: run.id, tornTail: Buffer.byteLength(tail) });
      }
      const line = tail && decode(run, tail) !== null ? tail : body.slice(body.lastIndexOf("\n") + 1);
      if (!line) return 0;
      const last = decode(run, line);
      if (!last) throw corrupt(run, 0, "its last line is not an event");
      return last.seq;
    }
  } finally {
    closeSync(fd);
  }
}

/** Runs `fn` under the events file's lock, handing it an append that does not take the lock again. */
export function withEventsLock<T>(
  run: Run,
  fn: (add: (e: RunEventInput, now?: Date) => RunEvent) => T | Promise<T>,
): Promise<T> {
  return withFileLock(eventsFile(run), () => fn((e, now) => writeEvents(run, [e], now)[0] as RunEvent));
}

/** The events with the next dense seqs, validated all before the one write that appends them. */
function writeEvents(run: Run, es: RunEventInput[], now: Date = new Date()): RunEvent[] {
  const stamp = (first: number) =>
    es.map((e, i) => RunEventSchema.parse({ v: EVENTS_SCHEMA, seq: first + i, at: now.toISOString(), ...e }));
  if (onFile(run)) {
    const out = stamp(lastSeq(run, true) + 1);
    appendJsonlBatch(eventsFile(run), out);
    return out;
  }
  const d = db();
  return d
    .transaction(() => {
      ensureRunRow(d, run);
      const out = stamp(lastEventSeq(run) + 1);
      for (const e of out) insertEvent(d, run.id, e);
      return out;
    })
    .immediate();
}

/** Appends one event under the file's lock, with the next dense `seq`, and returns it as written. */
export async function appendEvent(run: Run, e: RunEventInput, now: Date = new Date()): Promise<RunEvent> {
  return withEventsLock(run, (add) => add(e, now));
}

/** Appends events that belong together in one write under the file's lock: all of them or, on a crash, a torn tail. */
export function appendEvents(run: Run, es: RunEventInput[], now: Date = new Date()): Promise<RunEvent[]> {
  return withFileLock(eventsFile(run), () => writeEvents(run, es, now));
}

/**
 * Calls `onEvent` with each event after `fromSeq - 1`, in order, as they are appended, until the returned stop
 * is called; `last` marks the final event of one poll's batch. A poll that finds the file unreadable waits for the
 * next one.
 */
export function tailEvents(
  run: Run,
  fromSeq: number,
  onEvent: (e: RunEvent, last: boolean) => void,
  o: { pollMs?: number } = {},
): () => void {
  let next = fromSeq;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const poll = (): void => {
    if (stopped) return;
    try {
      const batch = readEvents(run, next);
      for (const [i, e] of batch.entries()) {
        if (stopped) return;
        next = e.seq + 1;
        onEvent(e, i === batch.length - 1);
      }
    } catch (err) {
      log("warn", "events", { run: run.id, tail: err instanceof Error ? err.message : String(err) });
    }
    if (!stopped) timer = setTimeout(poll, o.pollMs ?? 500);
  };
  poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
