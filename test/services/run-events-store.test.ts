import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { db } from "../../src/infra/db.ts";
import type { RunEvent } from "../../src/domain/run-events.ts";
import {
  appendEvent,
  appendEvents,
  eventsFile,
  hasRunEnded,
  isDaemonRun,
  lastEventSeq,
  readEvents,
  replayRun,
  tailEvents,
} from "../../src/services/run-events-store.ts";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { snapshotEnv } from "../helpers.ts";
import { freshRun, waitFor } from "./helpers.ts";

afterEach(snapshotEnv());

const STORE = fileURLToPath(new URL("../../src/services/run-events-store.ts", import.meta.url));
const RUN_STORE = fileURLToPath(new URL("../../src/services/run-store.ts", import.meta.url));

const started: RunEventInput = {
  type: "run.started",
  repo: "/r",
  title: "t",
  aLines: [],
  plan: [],
  base: null,
  engine: "2.0",
};
const line = (seq: number, type = "tick"): string =>
  JSON.stringify({ v: 1, seq, at: "2026-10-21T10:00:00.000Z", type });

describe("the event store", () => {
  it("readEvents reads from an id and a dir", async () => {
    const { run } = freshRun();
    await appendEvent(run, { type: "tick" });
    const ref = { id: run.id, dir: run.dir };
    expect(isDaemonRun(ref)).toBe(true);
    expect(eventsFile(ref)).toBe(eventsFile(run));
    expect(readEvents(ref)).toEqual(readEvents(run));
  });

  it("appends dense seqs from concurrent writers", async () => {
    const { run } = freshRun();
    await Promise.all(Array.from({ length: 30 }, () => appendEvent(run, { type: "tick" })));
    expect(readEvents(run).map((e) => e.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(isDaemonRun(run)).toBe(true);
  });

  it("appends dense seqs from two processes at once", async () => {
    const { run } = freshRun();
    const src = `import { appendEvent } from ${JSON.stringify(STORE)};
      import { findRun } from ${JSON.stringify(RUN_STORE)};
      const run = findRun(${JSON.stringify(run.id)});
      for (let i = 0; i < 20; i++) await appendEvent(run, { type: "tick" });`;
    const procs = [1, 2].map(() =>
      Bun.spawn([process.execPath, "-e", src], {
        env: { ...process.env, ANTHROPIC_API_KEY: "" },
        stderr: "pipe",
      }),
    );
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0]);
    expect(readEvents(run).map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("stamps v, seq and at, and keeps a new run's events in the database, never in events.jsonl", async () => {
    const { run } = freshRun();
    const e = await appendEvent(run, started, new Date("2026-10-21T10:00:00.000Z"));
    expect(e).toMatchObject({ v: 1, seq: 1, at: "2026-10-21T10:00:00.000Z", type: "run.started" });
    expect(existsSync(eventsFile(run))).toBe(false);
    expect(db().query("SELECT seq, type, body FROM events WHERE run_id = ?").all(run.id)).toEqual([
      { seq: 1, type: "run.started", body: JSON.stringify(e) },
    ]);
    expect(db().query("SELECT dir, legacy FROM runs WHERE id = ?").get(run.id)).toEqual({
      dir: run.dir,
      legacy: 0,
    });
    expect(replayRun(run).title).toBe("t");
    expect(lastEventSeq(run)).toBe(1);
    expect(hasRunEnded(run)).toBe(false);
  });

  it("keeps an earlier build's run on its events.jsonl, read and appended there (plan 46)", async () => {
    const { run } = freshRun();
    writeFileSync(eventsFile(run), `${line(1)}\n`);
    const e = await appendEvent(run, { type: "run.ended", outcome: "done", reportPath: null });
    expect(e.seq).toBe(2);
    expect(readFileSync(eventsFile(run), "utf8")).toBe(`${line(1)}\n${JSON.stringify(e)}\n`);
    expect(db().query("SELECT count(*) AS n FROM events WHERE run_id = ?").get(run.id)).toEqual({ n: 0 });
    expect(lastEventSeq(run)).toBe(2);
    expect(hasRunEnded(run)).toBe(true);
  });

  it("refuses a database row that is not an event", async () => {
    const { run } = freshRun();
    await appendEvent(run, { type: "tick" });
    db()
      .query("INSERT INTO events (run_id, seq, type, at, body) VALUES (?, 2, 'tick', 'x', 'not json')")
      .run(run.id);
    expect(() => readEvents(run)).toThrow(expect.objectContaining({ code: "E_RUN_CORRUPT" }));
  });

  it("appends a batch whole: dense seqs in one write, and nothing when one event is invalid", async () => {
    const { run } = freshRun();
    await appendEvent(run, { type: "tick" });
    const out = await appendEvents(run, [{ type: "tick" }, { type: "cancel.requested", by: "owner" }]);
    expect(out.map((e) => e.seq)).toEqual([2, 3]);
    expect(readEvents(run).map((e) => e.type)).toEqual(["tick", "tick", "cancel.requested"]);
    const bad = { type: "plan.ready" } as unknown as RunEventInput;
    expect(appendEvents(run, [{ type: "tick" }, bad])).rejects.toThrow();
    expect(readEvents(run)).toHaveLength(3);
  });

  it("reads from a seq", async () => {
    const { run } = freshRun();
    for (let i = 0; i < 5; i++) await appendEvent(run, { type: "tick" });
    expect(readEvents(run, 4).map((e) => e.seq)).toEqual([4, 5]);
    expect(readEvents(run, 9)).toEqual([]);
  });

  it("is not a 2.0 run until its first event", () => {
    expect(isDaemonRun(freshRun().run)).toBe(false);
    expect(readEvents(freshRun().run)).toEqual([]);
  });

  it("skips a torn last line and refuses a corrupt middle line", async () => {
    const { run } = freshRun();
    writeFileSync(eventsFile(run), `${line(1)}\n${line(2)}\n`);
    appendFileSync(eventsFile(run), '{"v":1,"seq":3,"at":"x","ty');
    expect(readEvents(run).map((e) => e.seq)).toEqual([1, 2]);
    writeFileSync(eventsFile(run), `${line(1)}\nnot json\n${line(3)}\n`);
    expect(() => readEvents(run)).toThrow(
      expect.objectContaining({ code: "E_RUN_CORRUPT", message: expect.stringContaining("after seq 1") }),
    );
    writeFileSync(eventsFile(run), `${line(1)}\n${line(3)}\n`);
    expect(() => readEvents(run)).toThrow(expect.objectContaining({ code: "E_RUN_CORRUPT" }));
  });

  it("cuts a torn tail off before the next append, and refuses to extend a corrupt log", async () => {
    const { run } = freshRun();
    writeFileSync(eventsFile(run), `${line(1)}\n${line(2)}\n{"v":1,"seq":3,"at":"x","ty`);
    const e = await appendEvent(run, { type: "tick" });
    expect(e.seq).toBe(3);
    expect(readEvents(run).map((x) => x.seq)).toEqual([1, 2, 3]);
    writeFileSync(eventsFile(run), `${line(1)}\ngarbage\n`);
    await expect(appendEvent(run, { type: "tick" })).rejects.toMatchObject({ code: "E_RUN_CORRUPT" });
  });

  it("never repairs a file-backed log when a reader asks for the last seq", () => {
    const { run } = freshRun();
    writeFileSync(eventsFile(run), `${line(1)}\n${line(2)}\n{"v":1,"seq":3,"at":"x","ty`);
    const before = readFileSync(eventsFile(run), "utf8");
    chmodSync(eventsFile(run), 0o400);
    expect(lastEventSeq(run)).toBe(2);
    expect(readFileSync(eventsFile(run), "utf8")).toBe(before);
  });

  it("refuses a run whose rows and events.jsonl both exist, rather than reading the file alone", async () => {
    const { run } = freshRun();
    await appendEvent(run, { type: "tick" });
    await appendEvent(run, { type: "tick" });
    writeFileSync(eventsFile(run), `${line(1)}\n`);
    for (const read of [() => readEvents(run), () => isDaemonRun(run), () => lastEventSeq(run)])
      expect(read).toThrow(
        expect.objectContaining({
          code: "E_RUN_CORRUPT",
          message: expect.stringMatching(/events\.jsonl.*catherd\.db/),
        }),
      );
    await expect(appendEvent(run, { type: "tick" })).rejects.toMatchObject({ code: "E_RUN_CORRUPT" });
  });

  it("finds the last seq in a file much bigger than one chunk", async () => {
    const { run } = freshRun();
    const big = "x".repeat(200_000);
    writeFileSync(
      eventsFile(run),
      `${JSON.stringify({ v: 1, seq: 1, at: "t", type: "report.posted", kind: "landed", unit: "M1", text: big })}\n`,
    );
    expect((await appendEvent(run, { type: "tick" })).seq).toBe(2);
  });

  it("refuses an event a newer catherd wrote", async () => {
    const { run } = freshRun();
    writeFileSync(eventsFile(run), `${JSON.stringify({ v: 2, seq: 1, at: "t", type: "tick" })}\n`);
    expect(() => readEvents(run)).toThrow(expect.objectContaining({ code: "E_RUNTIME_TOO_OLD" }));
    await expect(appendEvent(run, { type: "tick" })).rejects.toMatchObject({ code: "E_RUNTIME_TOO_OLD" });
  });

  it("tails new events in order until stopped", async () => {
    const { run } = freshRun();
    await appendEvent(run, { type: "tick" });
    const seen: number[] = [];
    const stop = tailEvents(run, 1, (e: RunEvent) => void seen.push(e.seq), { pollMs: 5 });
    await appendEvent(run, { type: "tick" });
    await appendEvent(run, { type: "tick" });
    await waitFor(() => (seen.length === 3 ? seen : null));
    expect(seen).toEqual([1, 2, 3]);
    stop();
    await appendEvent(run, { type: "tick" });
    await Bun.sleep(30);
    expect(seen).toEqual([1, 2, 3]);
  });
});
