import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { CatherdError, UPGRADE } from "../domain/errors.ts";
import { EVENTS_SCHEMA, RunEventSchema, type RunEvent, type RunEventInput } from "../domain/run-events.ts";
import { type RunState, replay } from "../domain/run-state.ts";
import { withFileLock } from "../infra/filelock.ts";
import { log } from "../infra/log.ts";
import { appendJsonl } from "../infra/store.ts";
import type { Run } from "./run-store.ts";

/** `<run>/events.jsonl`: one fact per line, dense `seq`, the only state a 2.0 run keeps. */
export const eventsFile = (run: Run): string => join(run.dir, "events.jsonl");

/** A 2.0 run has an events.jsonl; a run without one is a 1.5 run, and the daemon never drives it. */
export const isDaemonRun = (run: Run): boolean => existsSync(eventsFile(run));

const corrupt = (run: Run, after: number, why: string): CatherdError =>
  new CatherdError("E_RUN_CORRUPT", `${eventsFile(run)} is corrupt after seq ${after}: ${why}`, {
    fix: `restore events.jsonl from a backup, or finish run ${run.id} with catherd 1.x`,
  });

const tooOld = (run: Run, v: unknown): CatherdError =>
  new CatherdError(
    "E_RUNTIME_TOO_OLD",
    `${eventsFile(run)} holds events of version ${String(v)}, newer than this catherd (${EVENTS_SCHEMA})`,
    { fix: `upgrade catherd: ${UPGRADE}` },
  );

/** One line as an event: a newer `v` is too old a catherd, anything else invalid is corrupt (null here). */
function decode(run: Run, line: string): RunEvent | null {
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
export function readEvents(run: Run, fromSeq = 1): RunEvent[] {
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

export const replayRun = (run: Run): RunState => replay(readEvents(run), run.id);

/** The last seq of the file; a torn tail is cut off first, so the next line starts clean. Under the file's lock. */
function lastSeq(run: Run): number {
  const file = eventsFile(run);
  if (!existsSync(file)) return 0;
  const fd = openSync(file, "r+");
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
      if (tail && decode(run, tail) === null) {
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
  const file = eventsFile(run);
  return withFileLock(file, () =>
    fn((e, now = new Date()) => {
      const event = RunEventSchema.parse({
        v: EVENTS_SCHEMA,
        seq: lastSeq(run) + 1,
        at: now.toISOString(),
        ...e,
      });
      appendJsonl(file, event);
      return event;
    }),
  );
}

/** Appends one event under the file's lock, with the next dense `seq`, and returns it as written. */
export async function appendEvent(run: Run, e: RunEventInput, now: Date = new Date()): Promise<RunEvent> {
  return withEventsLock(run, (add) => add(e, now));
}

/**
 * Calls `onEvent` with each event after `fromSeq - 1`, in order, as they are appended, until the returned stop
 * is called. A poll that finds the file unreadable waits for the next one.
 */
export function tailEvents(
  run: Run,
  fromSeq: number,
  onEvent: (e: RunEvent) => void,
  o: { pollMs?: number } = {},
): () => void {
  let next = fromSeq;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const poll = (): void => {
    if (stopped) return;
    try {
      for (const e of readEvents(run, next)) {
        if (stopped) return;
        next = e.seq + 1;
        onEvent(e);
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
