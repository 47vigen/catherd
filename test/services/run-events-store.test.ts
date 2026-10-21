import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { RunEvent } from "../../src/domain/run-events.ts";
import {
  appendEvent,
  eventsFile,
  isDaemonRun,
  readEvents,
  replayRun,
  tailEvents,
} from "../../src/services/run-events-store.ts";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { snapshotEnv } from "../helpers.ts";
import { freshRun, waitFor } from "./helpers.ts";

afterEach(snapshotEnv());

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
  it("appends dense seqs from concurrent writers", async () => {
    const { run } = freshRun();
    await Promise.all(Array.from({ length: 30 }, () => appendEvent(run, { type: "tick" })));
    expect(readEvents(run).map((e) => e.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(isDaemonRun(run)).toBe(true);
  });

  it("stamps v, seq and at, and keeps the file private", async () => {
    const { run } = freshRun();
    const e = await appendEvent(run, started, new Date("2026-10-21T10:00:00.000Z"));
    expect(e).toMatchObject({ v: 1, seq: 1, at: "2026-10-21T10:00:00.000Z", type: "run.started" });
    expect(readFileSync(eventsFile(run), "utf8")).toBe(`${JSON.stringify(e)}\n`);
    expect(replayRun(run).title).toBe("t");
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
