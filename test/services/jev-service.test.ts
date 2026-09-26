import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JEV_BASE } from "../../src/infra/jev-client.ts";
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

const fx = (n: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "jev", n), "utf8"));
const runDir = () => mkdtempSync(join(tmpdir(), "catherd-jev-"));
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

  it("writes jev.jsonl with a header row, and never the state", () => {
    const dir = runDir();
    logJev(dir, {
      call: "finding",
      lane: null,
      questionSet: "finding#00000000",
      key: "k",
      stateHash: "h",
      model: null,
      requestId: null,
      usage: null,
      latencyMs: null,
      attempts: 0,
      cached: false,
      answers: null,
      derived: null,
      used: "code",
      source: "default",
      why: "no key",
    });
    const lines = readFileSync(join(dir, "jev.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0] as string)).toEqual({ schema: 1, kind: "jev" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain("Rename total");
  });
});
