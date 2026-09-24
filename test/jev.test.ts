import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRun } from "../src/core/runstore.ts";
import { configDir } from "../src/paths.ts";
import { askJev, callJev, JEV_URL, jevKey, QUESTIONS, saveJevKey, testJevKey } from "../src/routing/jev.ts";
import { fakeFetch } from "./fake-fetch.ts";
import { withHome } from "./helpers.ts";

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "jev", name), "utf8"));
const route = { kind: QUESTIONS.kind, difficulty: QUESTIONS.difficulty };
const fast = { retryDelayMs: 1 };

const saved = { ...process.env };
beforeEach(() => {
  withHome();
  process.env.TYPESAFE_API_KEY = "ts_test_key";
});
afterEach(() => {
  process.env = { ...saved };
});

describe("the key", () => {
  test("prefers TYPESAFE_API_KEY, trimmed, over the credentials file", () => {
    saveJevKey("ts_file_key");
    process.env.TYPESAFE_API_KEY = "  ts_env_key\n";
    expect(jevKey()).toBe("ts_env_key");
    delete process.env.TYPESAFE_API_KEY;
    expect(jevKey()).toBe("ts_file_key");
  });

  test("falls back to TypeSafe's own key file", () => {
    delete process.env.TYPESAFE_API_KEY;
    mkdirSync(join(process.env.XDG_CONFIG_HOME as string, "typesafe"), { recursive: true });
    writeFileSync(join(process.env.XDG_CONFIG_HOME as string, "typesafe", "api_key"), "ts_typesafe_key\n");
    expect(jevKey()).toBe("ts_typesafe_key");
  });

  test("returns null with no key anywhere", () => {
    delete process.env.TYPESAFE_API_KEY;
    expect(jevKey()).toBeNull();
  });

  test("stores the key with mode 600, even over a looser file", () => {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), "credentials.json"), "{}", { mode: 0o644 });
    saveJevKey("ts_file_key");
    expect(statSync(join(configDir(), "credentials.json")).mode & 0o777).toBe(0o600);
  });
});

describe("callJev", () => {
  test("sends the pinned model, the state and the questions with the bearer key", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-confident.json") });
    const r = await callJev(route, { lane: "add GET /jobs" }, { fetchImpl: f.impl });
    expect(r.error).toBeNull();
    expect(r.answers?.difficulty).toEqual({
      choice: "build",
      confidence: 0.95,
      probabilities: { hard: 0, logic: 0, copy: 0.04, build: 0.96 },
    });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({
      url: JEV_URL,
      method: "POST",
      body: { model: "jev-1.13.0", state: { lane: "add GET /jobs" }, questions: route },
    });
    expect(f.sent[0]?.headers.get("authorization")).toBe("Bearer ts_test_key");
  });

  test("retries 529 and succeeds on the third attempt", async () => {
    const f = fakeFetch(
      { status: 529, body: {} },
      { status: 529, body: {} },
      { status: 200, body: fx("route-confident.json") },
    );
    expect((await callJev(route, { lane: "x" }, { fetchImpl: f.impl, ...fast })).answers).not.toBeNull();
    expect(f.sent).toHaveLength(3);
  });

  test("gives up after three retries of a 5xx", async () => {
    const f = fakeFetch({ status: 503, body: {} });
    expect(await callJev(route, { lane: "x" }, { fetchImpl: f.impl, ...fast })).toEqual({
      answers: null,
      error: "http 503",
    });
    expect(f.sent).toHaveLength(4);
  });

  test("retries a network failure, then reports it", async () => {
    const f = fakeFetch(new TypeError("fetch failed"));
    expect((await callJev(route, { lane: "x" }, { fetchImpl: f.impl, ...fast })).error).toBe("network error");
    expect(f.sent).toHaveLength(4);
  });

  test("does not retry a 401", async () => {
    const f = fakeFetch({ status: 401, body: fx("auth-error.json") });
    expect((await callJev(route, { lane: "x" }, { fetchImpl: f.impl, ...fast })).error).toBe("http 401");
    expect(f.sent).toHaveLength(1);
  });

  test("treats a choice outside the options, or a missing answer, as unavailable", async () => {
    const offList = { answers: { difficulty: { choice: "medium", confidence: 0.99, probabilities: {} } } };
    const f1 = fakeFetch({ status: 200, body: offList });
    expect(
      await callJev({ difficulty: QUESTIONS.difficulty }, { lane: "x" }, { fetchImpl: f1.impl }),
    ).toEqual({
      answers: null,
      error: "no valid answer to difficulty",
    });
    const f2 = fakeFetch({ status: 200, body: { answers: {} } });
    expect((await callJev(route, { lane: "x" }, { fetchImpl: f2.impl })).error).toBe(
      "no valid answer to kind",
    );
    const f3 = fakeFetch({ status: 200, body: "<html>bad gateway</html>" });
    expect((await callJev(route, { lane: "x" }, { fetchImpl: f3.impl })).error).toBe("unexpected response");
  });

  test("sends nothing without a key", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const f = fakeFetch({ status: 200, body: fx("route-confident.json") });
    expect(await callJev(route, { lane: "x" }, { fetchImpl: f.impl })).toEqual({
      answers: null,
      error: "no key",
    });
    expect(f.sent).toHaveLength(0);
  });
});

describe("askJev", () => {
  test("logs one row per call to the run's jev.jsonl, without the key or the state", async () => {
    const run = createRun("/r/app", "t", []);
    const ok = fakeFetch({ status: 200, body: fx("route-confident.json") });
    expect(
      (await askJev(route, { lane: "secret lane text" }, { runDir: run.dir, fetchImpl: ok.impl }))?.kind
        ?.choice,
    ).toBe("repo_code");
    const bad = fakeFetch({ status: 401, body: fx("auth-error.json") });
    expect(
      await askJev(route, { lane: "secret lane text" }, { runDir: run.dir, fetchImpl: bad.impl, ...fast }),
    ).toBeNull();
    const log = readFileSync(join(run.dir, "jev.jsonl"), "utf8");
    const rows = log
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      questions: ["kind", "difficulty"],
      used: "kind=repo_code difficulty=build",
      source: "jev",
    });
    expect(rows[1]).toMatchObject({ answers: null, used: "none", source: "default", why: "http 401" });
    expect(log).not.toContain("ts_test_key");
    expect(log).not.toContain("secret lane text");
  });
});

describe("testJevKey", () => {
  test("passes a key that answers, with that key and not the stored one", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-confident.json") });
    expect(await testJevKey("ts_new_key", { fetchImpl: f.impl })).toBe(true);
    expect(f.sent[0]?.headers.get("authorization")).toBe("Bearer ts_new_key");
  });

  test("fails a key that is refused", async () => {
    expect(
      await testJevKey("ts_bad_key", {
        fetchImpl: fakeFetch({ status: 401, body: fx("auth-error.json") }).impl,
      }),
    ).toBe(false);
  });
});
