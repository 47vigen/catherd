import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JEV_BASE } from "../../src/infra/jev-client.ts";
import { logFile } from "../../src/infra/log.ts";
import {
  askJev,
  credentialsPath,
  jevKey,
  logJev,
  saveJevKey,
  testJevKey,
} from "../../src/services/jev-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());
// every test gets its own CATHERD_HOME, so Jev log rows never reach the real data dir
beforeEach(() => void withHome());
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const fx = (n: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "jev", n), "utf8"));
const runDir = (): string => {
  withHome();
  const d = mkdtempSync(join(tmpdir(), "catherd-jev-"));
  dirs.push(d);
  return d;
};
const noWait = { sleep: async () => {}, random: () => 0.5 };
const STATE = { title: "M1.L1 — x", owns: ["src/a.ts"], fast_check: "true", body: "Rename total to sum." };

describe("the Jev key", () => {
  it("comes from TYPESAFE_API_KEY, else credentials.json, which is saved at mode 600", () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    expect(jevKey()).toBeNull();
    saveJevKey("  ts-file  ");
    expect(jevKey()).toBe("ts-file");
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
      schema: 1,
      typesafeApiKey: "ts-file",
    });
    process.env.TYPESAFE_API_KEY = "ts-env";
    expect(jevKey()).toBe("ts-env");
  });

  it("reads a 0.x credentials file and keeps its other fields", () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    saveJevKey("a");
    writeFileSync(credentialsPath(), JSON.stringify({ typesafeApiKey: "old", other: 1 }));
    expect(jevKey()).toBe("old");
    saveJevKey("new");
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
      schema: 1,
      typesafeApiKey: "new",
      other: 1,
    });
  });

  it("refuses to overwrite a newer-schema or unreadable credentials file", () => {
    withHome();
    saveJevKey("a");
    for (const text of [JSON.stringify({ schema: 2, typesafeApiKey: "x", other: 1 }), "{not json"]) {
      writeFileSync(credentialsPath(), text);
      expect(() => saveJevKey("new")).toThrow();
      expect(readFileSync(credentialsPath(), "utf8")).toBe(text);
    }
  });

  it("is tested by listing Jev's models", async () => {
    const f = fakeFetch({ status: 200, body: { data: [] } }, { status: 401, body: fx("auth-error.json") });
    expect(await testJevKey("k", { fetchImpl: f.impl, ...noWait })).toBe(true);
    expect(await testJevKey("k", { fetchImpl: f.impl, ...noWait })).toBe(false);
    expect(f.sent[0]).toMatchObject({ url: `${JEV_BASE}/models`, method: "GET" });
  });
});

describe("askJev", () => {
  it("sends the pinned model, the state and the set's questions, and returns the answers with their metadata", async () => {
    const dir = runDir();
    const f = fakeFetch({
      status: 200,
      body: fx("route-v2-track-a.json"),
      headers: { "x-typesafe-request-id": "req_9" },
    });
    const a = await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: f.impl, ...noWait });
    expect(f.sent[0]?.body).toMatchObject({ model: "jev-1.13.0", state: STATE });
    const sent = f.sent[0]?.body as { questions: object } | undefined;
    expect(Object.keys(sent?.questions ?? {})).toContain("names_pattern");
    expect(a.why).toBeNull();
    expect(a.answers?.kind?.type).toBe("choice");
    expect(a.meta).toMatchObject({
      questionSet: expect.stringMatching(/^route-v2#[0-9a-f]{8}$/),
      model: "jev-1.13.0",
      requestId: "req_9",
      usage: { input_tokens: 812, output_tokens: 210 },
      attempts: 1,
      cached: false,
    });
  });

  it("answers the same request from this run's log, and asks again for a changed state", async () => {
    const dir = runDir();
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const first = await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: f.impl, ...noWait });
    logJev(dir, {
      ...first.meta,
      call: "route-v2",
      lane: "M1.L1",
      answers: first.answers,
      derived: null,
      used: "x",
      source: "jev",
      why: "ok",
    });
    const again = await askJev(dir, "route-v2", { ...STATE }, { key: "k", fetchImpl: f.impl, ...noWait });
    expect(again.meta.cached).toBe(true);
    expect(again.answers).toEqual(first.answers);
    expect(f.sent).toHaveLength(1);
    await askJev(
      dir,
      "route-v2",
      { ...STATE, body: "Something else." },
      { key: "k", fetchImpl: f.impl, ...noWait },
    );
    expect(f.sent).toHaveLength(2);
  });

  it("gives no answers without a key, on an HTTP error, or on a reply that does not fit the questions", async () => {
    const dir = runDir();
    expect((await askJev(dir, "route-v2", STATE, { key: null })).why).toBe("no key");
    const auth = fakeFetch({ status: 401, body: fx("auth-error.json") });
    expect((await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: auth.impl, ...noWait })).why).toBe(
      "http 401",
    );
    const old = fakeFetch({ status: 200, body: fx("route-confident.json") });
    expect((await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: old.impl, ...noWait })).why).toBe(
      "no valid answer to difficulty",
    );
  });

  it("notes answers from a model other than the pinned one", async () => {
    const body = { ...(fx("route-v2-track-a.json") as object), model: "jev-1.14.0" };
    const f = fakeFetch({ status: 200, body });
    const a = await askJev(runDir(), "route-v2", STATE, { key: "k", fetchImpl: f.impl, ...noWait });
    expect(a.answers).not.toBeNull();
    expect(a.why).toBe("answered by jev-1.14.0, not the pinned jev-1.13.0");
  });

  it("keeps the unpinned-model note when answering from the log", async () => {
    const dir = runDir();
    const body = { ...(fx("route-v2-track-a.json") as object), model: "jev-1.14.0" };
    const f = fakeFetch({ status: 200, body });
    const first = await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: f.impl, ...noWait });
    logJev(dir, {
      ...first.meta,
      call: "route-v2",
      lane: "M1.L1",
      answers: first.answers,
      derived: null,
      used: "x",
      source: "jev",
      why: first.why ?? "ok",
    });
    const again = await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: f.impl, ...noWait });
    expect(again.meta.cached).toBe(true);
    expect(again.why).toBe("answered by jev-1.14.0, not the pinned jev-1.13.0");
  });

  it("writes jev.jsonl with a header row, and never the state", async () => {
    const dir = runDir();
    const asked = await askJev(dir, "route-v2", STATE, { key: null });
    logJev(dir, {
      ...asked.meta,
      call: "route-v2",
      lane: null,
      answers: null,
      derived: null,
      used: "code",
      source: "default",
      why: asked.why ?? "",
    });
    const lines = readFileSync(join(dir, "jev.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0] as string)).toEqual({ schema: 1, kind: "jev" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain(STATE.body);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ why: "no key", stateHash: asked.meta.stateHash });
  });
});

describe("askJev and the log", () => {
  it("logs each Jev call with its question set and state hash, never the state or the key", async () => {
    withHome();
    delete process.env.CATHERD_LOG;
    const key = "tsk-live-abcdefghijkl";
    const f = fakeFetch({ status: 503, body: { error: "down" } });
    await askJev(
      mkdtempSync(join(tmpdir(), "catherd-jevlog-")),
      "route-v2",
      { title: "lane secret-title" },
      { key, fetchImpl: f.impl, retries: 0 },
    );
    const text = readFileSync(logFile(), "utf8");
    const row = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((r) => r.event === "jev");
    expect(row).toMatchObject({ level: "warn", set: "route-v2", attempts: 1, error: "http 503" });
    expect(row.questionSet).toStartWith("route-v2#");
    expect(text).not.toContain("secret-title");
    expect(text).not.toContain(key);
  });
});
