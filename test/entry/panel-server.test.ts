import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { brotliCompressSync } from "node:zlib";
import { dirname, join } from "node:path";
import { RunModelSchema } from "../../src/domain/run-graph.ts";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { TranscriptPageSchema } from "../../src/domain/transcript.ts";
import { defaultDeps } from "../../src/entry/deps.ts";
import { OPERATIONS, ProfilePreviewSchema } from "../../src/entry/panel/openapi.ts";
import {
  type Panel,
  PANEL_COOKIE,
  panelHost,
  panelOriginOk,
  servePanel,
} from "../../src/entry/panel/server.ts";
import { ProfileSavedSchema } from "../../src/services/panel-setup.ts";
import { probeCache } from "../../src/services/probe-cache.ts";
import { CHANGED_ON_DISK } from "../../src/services/profile-service.ts";
import { dispatchDir } from "../../src/services/run-files.ts";
import { daemonLauncher } from "../../src/services/daemon.ts";
import { runStart } from "../../src/services/run-client.ts";
import { RunViewSchema, runTimeline } from "../../src/services/run-read.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import { createRun, findRun, type Run } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { seedFixtureRun } from "../services/fixture-run.ts";
import { waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());

const real = daemonLauncher.launch;
const TOKEN = "t".repeat(43);
const deps = defaultDeps({ host: "codex", session: null, conflict: null });
let repo: string;
let panel: Panel;
let base: string;

beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  withHome();
  repo = tempRepo();
  daemonLauncher.launch = () => 1;
  const dist = mkdtempSync(join(tmpdir(), "catherd-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dist, "assets", "a.js"), "console.log(1)");
  writeFileSync(join(dist, "assets", "a.js.br"), brotliCompressSync("console.log(1)"));
  panel = servePanel({
    deps,
    repo,
    token: TOKEN,
    port: 0,
    distDir: dist,
    open: false,
    pollMs: 10,
  });
  base = panel.url;
});
afterEach(async () => {
  await panel.stop();
  daemonLauncher.launch = real;
});

async function signIn(): Promise<string> {
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ token: TOKEN }),
    headers: { "content-type": "application/json" },
  });
  expect(r.status).toBe(204);
  return (r.headers.get("set-cookie") as string).split(";")[0] as string;
}
const call = async (cookie: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      cookie,
      "content-type": "application/json",
      ...(init.headers as Record<string, string>),
    },
  });
const post = (cookie: string, path: string, body: unknown) =>
  call(cookie, path, { method: "POST", body: JSON.stringify(body) });

async function start(title: string): Promise<string> {
  return (await runStart(deps, { repo, title, aLines: ["A1 it works"] })).run;
}

describe("the panel server", () => {
  it("serves the built files, falls back to index.html for a deep link, and stays inside the build", async () => {
    expect(await (await fetch(`${base}/runs/abc`)).text()).toContain('<div id="root">');
    const br = await fetch(`${base}/assets/a.js`, {
      headers: { "accept-encoding": "br, gzip" },
    });
    expect([br.headers.get("content-encoding"), br.headers.get("cache-control")]).toEqual([
      "br",
      "public, max-age=31536000, immutable",
    ]);
    expect(
      (
        await fetch(`${base}/assets/a.js`, {
          headers: { "accept-encoding": "identity" },
        })
      ).headers.get("content-encoding"),
    ).toBeNull();
    // Bun folds a `%2e%2e` segment away before the handler sees it; an encoded slash survives it and is refused
    const rawGet = (target: string) =>
      new Promise<string>((done) => {
        let text = "";
        void Bun.connect({
          hostname: "127.0.0.1",
          port: panel.port,
          socket: {
            open: (s) =>
              void s.write(
                `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${panel.port}\r\nConnection: close\r\n\r\n`,
              ),
            data: (_s, d) => void (text += d.toString()),
            close: () => done(text),
          },
        });
      });
    expect((await rawGet("/..%2fpackage.json")).split("\r\n")[0]).toBe("HTTP/1.1 404 Not Found");
    expect(await rawGet("/%2e%2e/package.json")).not.toContain("catherd-cli");
  });

  it("answers 401 to the API without a session, and signs in with the token only", async () => {
    expect((await fetch(`${base}/api/runs`)).status).toBe(401);
    const bad = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("set-cookie")).toMatch(
      new RegExp(`^${PANEL_COOKIE}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=/`),
    );
    expect(ok.headers.get("x-frame-options")).toBe("DENY");
  });

  it("forgets a session on logout", async () => {
    const cookie = await signIn();
    expect((await call(cookie, "/api/auth/session")).status).toBe(200);
    expect((await post(cookie, "/api/auth/logout", {})).status).toBe(204);
    expect((await call(cookie, "/api/auth/session")).status).toBe(401);
  });

  it("refuses a Host it does not serve, and a write or a socket from another origin", async () => {
    const cookie = await signIn();
    const id = await start("wallet split");
    expect(
      (
        await fetch(`${base}/api/runs`, {
          headers: { cookie, host: `evil.test:${panel.port}` },
        })
      ).status,
    ).toBe(403);
    expect((await post(cookie, `/api/runs/${id}/cancel`, {})).status).toBe(200);
    const evil = await call(cookie, `/api/runs/${id}/cancel`, {
      method: "POST",
      headers: { origin: "http://evil.test" },
    });
    expect(evil.status).toBe(403);
    const up = await fetch(`${base}/api/runs/${id}/live`, {
      headers: {
        cookie,
        origin: "http://evil.test",
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(up.status).toBe(403);
  });

  it("accepts the portless Host a browser sends on port 80, and only there", () => {
    expect(panelHost("127.0.0.1:8123", 8123)).toBe("127.0.0.1:8123");
    expect(panelHost("127.0.0.1", 8123)).toBeNull();
    expect(panelHost("127.0.0.1", 80)).toBe("127.0.0.1");
    expect(panelHost("localhost", 80)).toBe("localhost");
    expect(panelHost("localhost:80", 80)).toBe("localhost:80");
    expect(panelHost("evil.test", 80)).toBeNull();
    expect(panelHost(null, 80)).toBeNull();
    // the Origin follows the Host: no :80 on either side
    expect(panelOriginOk("http://127.0.0.1", "127.0.0.1")).toBe(true);
    expect(panelOriginOk("http://localhost", "localhost")).toBe(true);
    expect(panelOriginOk("http://evil.test", "127.0.0.1")).toBe(false);
    expect(panelOriginOk(null, "127.0.0.1")).toBe(true);
  });

  it("lists runs paged and searched, and returns one run", async () => {
    const cookie = await signIn();
    const a = await start("wallet split");
    await start("docs pass");
    const found = (await (await call(cookie, "/api/runs?q=wallet")).json()) as {
      items: { id: string }[];
      total: number;
    };
    expect([found.total, found.items[0]?.id]).toEqual([1, a]);
    const paged = (await (await call(cookie, "/api/runs?limit=1")).json()) as {
      items: unknown[];
      total: number;
    };
    expect([paged.items.length, paged.total]).toEqual([1, 2]);
    expect(RunViewSchema.parse(await (await call(cookie, `/api/runs/${a}`)).json()).id).toBe(a);
    expect((await call(cookie, "/api/runs?limit=0")).status).toBe(400);
  });

  it("returns a run's timeline newest first, paged", async () => {
    const cookie = await signIn();
    const id = await start("wallet split");
    await appendEvent(findRun(id), {
      type: "question.parked",
      unit: "M1.L2",
      question: "q",
      reason: "needs_user",
    });
    const t = (await (await call(cookie, `/api/runs/${id}/timeline`)).json()) as {
      items: { seq: number }[];
      total: number;
    };
    expect([t.items[0]!.seq > t.items[1]!.seq, t.total]).toEqual([true, runTimeline(id).length]);
    const one = (await (await call(cookie, `/api/runs/${id}/timeline?limit=1&offset=1`)).json()) as {
      items: { seq: number }[];
    };
    expect(one.items.map((i) => i.seq)).toEqual([t.items[1]!.seq]);
  });

  it("a 1.5 run's timeline is empty", async () => {
    const cookie = await signIn();
    const run = createRun({ repo, title: "old", aLines: [], version: "1.5.0" });
    const t = await (await call(cookie, `/api/runs/${run.id}/timeline`)).json();
    expect(t).toEqual({ items: [], total: 0 });
    expect(
      (
        (await (await call(cookie, `/api/runs/${run.id}`)).json()) as {
          engine: string;
        }
      ).engine,
    ).toBe("1.5");
  });

  it("lists parked questions, answers one through the run client, and refuses a second answer for the same unit with the error body", async () => {
    const cookie = await signIn();
    const id = await start("wallet split");
    await appendEvent(findRun(id), {
      type: "question.parked",
      unit: "M1.L2",
      question: "Keep the id?",
      reason: "needs_user",
    });
    const list = (await (await call(cookie, "/api/questions")).json()) as {
      items: { unit: string }[];
      total: number;
    };
    expect([list.total, list.items[0]?.unit]).toEqual([1, "M1.L2"]);
    expect(
      (
        (await (await call(cookie, `/api/questions?q=nothing`)).json()) as {
          total: number;
        }
      ).total,
    ).toBe(0);
    const first = await post(cookie, `/api/runs/${id}/answers`, {
      unit: "M1.L2",
      answer: "keep it",
    });
    expect([first.status, ((await first.json()) as { unit: string }).unit]).toEqual([200, "M1.L2"]);
    expect(readEvents(findRun(id)).at(-1)?.type).toBe("question.answered");
    const second = await post(cookie, `/api/runs/${id}/answers`, {
      unit: "M1.L2",
      answer: "again",
    });
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("E_INPUT_INVALID");
    expect((await call(cookie, "/api/runs/nope")).status).toBe(404);
  });

  it("cancels a run", async () => {
    const cookie = await signIn();
    const id = await start("wallet split");
    const r = await post(cookie, `/api/runs/${id}/cancel`, {});
    expect([r.status, ((await r.json()) as { cancelling: boolean }).cancelling]).toEqual([200, true]);
  });

  it("saves a role's rungs through the profile service and refuses a role that does not exist", async () => {
    process.env.PATH = "/nonexistent"; // GET /api/setup probes each backend's CLI: none is found, none is spawned
    const cookie = await signIn();
    const put = (role: string, rungs: string[]) =>
      call(cookie, `/api/setup/roles/${role}`, {
        method: "PUT",
        body: JSON.stringify({ rungs }),
      });
    const ok = await put("reviewer", ["codex:gpt-6-sol#high"]);
    expect([ok.status, ProfileSavedSchema.parse(await ok.json()).saved]).toEqual([200, true]);
    expect((await put("boss", ["codex:gpt-6-sol#high"])).status).toBe(400);
    expect((await call(cookie, "/api/setup")).status).toBe(200);
  });

  it("answers 400, with the security headers, to a malformed escape in a run id", async () => {
    const cookie = await signIn();
    const r = await call(cookie, "/api/runs/%E0");
    expect([r.status, r.headers.get("x-frame-options")]).toEqual([400, "DENY"]);
    const ws = await call(cookie, "/api/runs/%E0/live", { headers: { upgrade: "websocket" } });
    expect([ws.status, ws.headers.get("x-frame-options")]).toEqual([400, "DENY"]);
  });

  it("refuses a body that does not parse, naming the field", async () => {
    const cookie = await signIn();
    const id = await start("wallet split");
    const r = await post(cookie, `/api/runs/${id}/answers`, {
      unit: "",
      answer: "x",
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("unit");
  });

  it("streams a run's new events over the socket, each frame what runTimeline gives, and refuses a socket without a session", async () => {
    const cookie = await signIn();
    const id = await start("wallet split");
    const next = readEvents(findRun(id)).length + 1;
    const frames: unknown[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/runs/${id}/live?from=${next}`, {
      headers: { cookie },
    } as never);
    const got = new Promise<void>((done) => {
      ws.onmessage = (m) => {
        frames.push(JSON.parse(String(m.data)));
        done();
      };
    });
    await new Promise<void>((r) => (ws.onopen = () => r()));
    const e = await appendEvent(findRun(id), {
      type: "question.parked",
      unit: "M1.L2",
      question: "q",
      reason: "needs_user",
    });
    await got;
    expect(frames[0]).toMatchObject({ ...runTimeline(id, e.seq, 1)[0], kind: "event" });
    // without `from` a socket starts at the end: the history comes over HTTP
    const tail = new WebSocket(`${base.replace("http", "ws")}/api/runs/${id}/live`, {
      headers: { cookie },
    } as never);
    const tailed: { seq: number }[] = [];
    tail.onmessage = (m) => void tailed.push(JSON.parse(String(m.data)));
    await new Promise<void>((r) => (tail.onopen = () => r()));
    const e2 = await appendEvent(findRun(id), {
      type: "question.parked",
      unit: "M1.L3",
      question: "q",
      reason: "needs_user",
    });
    await waitFor(() => tailed.length > 0);
    expect(tailed.map((t) => t.seq)).toEqual([e2.seq]);
    tail.close();
    // `from` replays what the page missed between its fetch and the upgrade, in order, then keeps tailing
    const replayed: { seq: number }[] = [];
    const gap = new WebSocket(`${base.replace("http", "ws")}/api/runs/${id}/live?from=${e.seq}`, {
      headers: { cookie },
    } as never);
    gap.onmessage = (m) => void replayed.push(JSON.parse(String(m.data)));
    await waitFor(() => replayed.length >= 2);
    expect(replayed.map((t) => t.seq)).toEqual([e.seq, e2.seq]);
    gap.close();
    ws.close();
    const anon = await fetch(`${base}/api/runs/${id}/live`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    expect(anon.status).toBe(401);
  });

  it("closes a session's run sockets when it logs out, and they stream nothing more", async () => {
    const cookie = await signIn();
    const other = await signIn();
    const id = await start("wallet split");
    const open = async (c: string) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/api/runs/${id}/live`, {
        headers: { cookie: c },
      } as never);
      const seen = { frames: 0, code: 0 };
      ws.onmessage = () => void seen.frames++;
      ws.onclose = (e) => void (seen.code = e.code);
      await new Promise<void>((r) => (ws.onopen = () => r()));
      return { ws, seen };
    };
    const mine = await open(cookie);
    const theirs = await open(other);
    expect((await post(cookie, "/api/auth/logout", {})).status).toBe(204);
    await waitFor(() => mine.seen.code !== 0);
    expect(mine.seen.code).toBe(4401);
    await appendEvent(findRun(id), {
      type: "question.parked",
      unit: "M1.L4",
      question: "q",
      reason: "needs_user",
    });
    await waitFor(() => theirs.seen.frames > 0);
    expect([mine.seen.frames, theirs.seen.code]).toEqual([0, 0]);
    theirs.ws.close();
  });

  it("listens on 127.0.0.1 only", () => {
    expect(panel.url).toStartWith("http://127.0.0.1:");
  });
});

describe("the sign-in page", () => {
  it("hands the opener a 0600 file in a 0700 dir, not the token, and deletes it after sign-in", async () => {
    const opened: string[] = [];
    const dist = mkdtempSync(join(tmpdir(), "catherd-dist-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    const p = servePanel({
      deps,
      repo,
      token: TOKEN,
      port: 0,
      distDir: dist,
      open: true,
      opener: (t) => void opened.push(t),
    });
    try {
      const [file] = opened as [string];
      expect(opened).toHaveLength(1);
      expect(file).not.toContain(TOKEN);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
      expect(readFileSync(file, "utf8")).toContain(`${p.url}/login#token=${TOKEN}`);
      const r = await fetch(`${p.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ token: TOKEN }),
      });
      expect(r.status).toBe(204);
      expect(existsSync(file)).toBe(false);
    } finally {
      await p.stop();
    }
  });

  it("removes the page when the server stops before anyone signs in", async () => {
    const opened: string[] = [];
    const dist = mkdtempSync(join(tmpdir(), "catherd-dist-"));
    const p = servePanel({
      deps,
      repo,
      token: TOKEN,
      port: 0,
      distDir: dist,
      open: true,
      opener: (t) => void opened.push(t),
    });
    await p.stop();
    expect(existsSync(opened[0] as string)).toBe(false);
  });
});

// ---- panel v2: the operations and the socket frames ----

const D1 = "d-20261023-100000-aaaaaa";
const planReady: RunEventInput = {
  type: "plan.ready",
  milestones: [
    {
      id: "M1",
      title: "m",
      after: [],
      lanes: [{ id: "M1.L1", role: "worker", kind: null, after: [], owns: ["src/a/**"] }],
    },
  ],
};
const dStarted: RunEventInput = {
  type: "dispatch.started",
  dispatchId: D1,
  name: "worker-M1.L1",
  role: "worker",
  unit: "M1.L1",
  lane: "M1.L1",
  rung: "codex:gpt-6-sol#high",
  thread: null,
};
const dEnded: RunEventInput = {
  type: "dispatch.ended",
  dispatchId: D1,
  name: "worker-M1.L1",
  unit: "M1.L1",
  status: "ok",
  replyStatus: "complete",
  reason: null,
  why: "all done",
  thread: null,
  head: null,
  environment: null,
  verdict: null,
  findings: [],
  foreign: [],
  replyPath: "reply.md",
};
const getJson = async <T = Record<string, any>>(cookie: string, path: string): Promise<T> =>
  (await (await call(cookie, path)).json()) as T;
const errorCode = async (r: Response): Promise<string> =>
  ((await r.json()) as { error: { code: string } }).error.code;

/** A live run: planned, with one worker dispatch started (D1). */
async function liveRun(title: string): Promise<Run> {
  const run = findRun(await start(title));
  await appendEvent(run, planReady);
  await appendEvent(run, dStarted);
  return run;
}

describe("the panel's v2 operations", () => {
  it("the overview counts the runs and lists the live one with its now line", async () => {
    const cookie = await signIn();
    await liveRun("wallet split");
    const o = await getJson(cookie, "/api/overview");
    expect(o.kpis.runs).toBe(1);
    expect(o.live).toHaveLength(1);
    expect(o.live[0].now[0].text).toMatch(/is writing the code for M1.L1$/);
    expect((await call(cookie, "/api/overview?from=nonsense")).status).toBe(400);
    const none = await getJson(cookie, "/api/overview?from=2020-01-01&to=2020-01-02");
    expect([none.kpis.runs, none.live.length]).toEqual([0, 1]);
  });

  it("lists runs from the index, filtered by repo", async () => {
    const cookie = await signIn();
    const a = await start("wallet split");
    const fixture = seedFixtureRun();
    const all = await getJson(cookie, "/api/runs");
    expect(all.items.map((r: { id: string }) => r.id).toSorted()).toEqual([a, fixture.id].toSorted());
    expect(all.items[0]).toHaveProperty("milestones.landed");
    const here = await getJson(cookie, `/api/runs?repo=${encodeURIComponent(repo)}`);
    expect(here.items.map((r: { id: string }) => r.id)).toEqual([a]);
    const there = await getJson(cookie, `/api/runs?repo=${encodeURIComponent(fixture.meta.repo)}`);
    expect(there.items.map((r: { id: string }) => r.id)).toEqual([fixture.id]);
    expect((await getJson(cookie, "/api/runs?phase=ended")).items.map((r: { id: string }) => r.id)).toEqual([
      fixture.id,
    ]);
  });

  it("returns the model, a dispatch, its stream paged and raw, a doc, a lane's checks and a run commit's diff", async () => {
    const cookie = await signIn();
    const run = seedFixtureRun();
    const base = `/api/runs/${run.id}`;
    const model = RunModelSchema.parse(await getJson(cookie, `${base}/model`));
    expect(model.nodes.map((n) => n.id)).toContain("M1/lane/M1.L1");
    const worker = model.nodes.find((n) => n.id === "M1/lane/M1.L1")?.attempts.at(-1)?.dispatchId as string;
    const d = await getJson(cookie, `${base}/dispatches/${worker}`);
    expect([d.name, d.role, d.brief.length > 0]).toEqual(["worker-M1.L1", "worker", true]);
    // the fixture keeps no role stream: write the real codex one beside the dispatch
    const dir = dispatchDir(run, worker);
    mkdirSync(dir, { recursive: true });
    copyFileSync(
      join(import.meta.dir, "../fixtures/transcript/codex-worker.jsonl"),
      join(dir, "events.jsonl"),
    );
    const first = TranscriptPageSchema.parse(
      await getJson(cookie, `${base}/dispatches/${worker}/stream?limit=3`),
    );
    expect([first.next, first.raw, first.ended, first.items.length > 0]).toEqual([3, null, true, true]);
    const rest = TranscriptPageSchema.parse(
      await getJson(cookie, `${base}/dispatches/${worker}/stream?from=3&limit=2000&raw=1`),
    );
    expect([rest.next, rest.items, rest.raw?.length]).toEqual([31, [], 28]);
    expect((await call(cookie, `${base}/dispatches/${worker}/stream?limit=0`)).status).toBe(400);
    expect(await getJson(cookie, `${base}/docs?name=plan.md`)).toMatchObject({ name: "plan.md" });
    const checks = await getJson(cookie, `${base}/checks/M1.L1`);
    expect([checks.lane, checks.name]).toEqual(["M1.L1", "worker-M1.L1"]);

    // a commit the run made, in the run's own repo
    const live = findRun(await start("diff run"));
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo }).toString();
    writeFileSync(join(repo, "x.ts"), "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const sha = git("rev-parse", "HEAD").trim();
    await appendEvent(live, { type: "commit.made", milestone: "M1", round: 0, commit: sha });
    const diff = await getJson(cookie, `/api/runs/${live.id}/commits/${sha}/diff`);
    expect([diff.sha, diff.truncated, diff.text.includes("x.ts")]).toEqual([sha, false, true]);
  });

  it("refuses a doc outside the run's docs and a sha the run did not make", async () => {
    const cookie = await signIn();
    const run = await liveRun("wallet split");
    const base = `/api/runs/${run.id}`;
    for (const name of ["../meta.json", "runs.jsonl", "lanes/../x.md", "/etc/passwd"])
      expect((await call(cookie, `${base}/docs?name=${encodeURIComponent(name)}`)).status).toBe(400);
    expect((await call(cookie, `${base}/docs`)).status).toBe(400);
    expect((await call(cookie, `${base}/docs?name=report.md`)).status).toBe(404);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    for (const sha of [head, head.slice(0, 8), "--output=x", "abc"])
      expect((await call(cookie, `${base}/commits/${sha}/diff`)).status).toBe(400);
    expect((await call(cookie, `${base}/dispatches/d-nope`)).status).toBe(400);
    expect((await call(cookie, `${base}/dispatches/d-nope/stream`)).status).toBe(400);
    expect((await call(cookie, `${base}/dispatches/..%2fx`)).status).toBe(400);
    expect((await call(cookie, `${base}/checks/..%2fx`)).status).toBe(400);
    expect((await call(cookie, "/api/runs/nope/model")).status).toBe(404);
  });

  it("pauses and resumes a run; cancelling a role with nothing live is 409", async () => {
    const cookie = await signIn();
    const id = await start("wallet split");
    const paused = await post(cookie, `/api/runs/${id}/pause`, {});
    const since = ((await paused.json()) as { paused: true; since: string }).since;
    expect([paused.status, since]).toEqual([200, expect.stringMatching(/^\d{4}-/)]);
    expect((await getJson(cookie, `/api/runs/${id}`)).paused).toBe(since);
    expect(await (await post(cookie, `/api/runs/${id}/resume`, {})).json()).toEqual({ paused: false });
    expect((await getJson(cookie, `/api/runs/${id}`)).paused).toBeNull();
    const none = await post(cookie, `/api/runs/${id}/roles/worker-M1.L1/cancel`, {});
    expect([none.status, await errorCode(none)]).toEqual([409, "E_RUN_NOT_LIVE"]);
  });

  it("lists a question with its context, and the answers of the last day", async () => {
    const cookie = await signIn();
    const id = await start("wallet split");
    await appendEvent(findRun(id), {
      type: "question.parked",
      unit: "M1.L2",
      question: "Keep the id?",
      reason: "needs_user",
    });
    const q = await getJson(cookie, "/api/questions");
    expect(q.items[0].context).toMatchObject({ node: expect.any(String), reply: null });
    expect((await post(cookie, `/api/runs/${id}/answers`, { unit: "M1.L2", answer: "keep it" })).status).toBe(
      200,
    );
    const done = await getJson(cookie, "/api/questions/answered");
    expect(done.items).toHaveLength(1);
    expect(done.items[0]).toMatchObject({ run: id, runTitle: "wallet split", unit: "M1.L2", by: "owner" });
    expect((await getJson(cookie, "/api/questions/answered?run=other")).items).toEqual([]);
  });

  it("filters a run's timeline by event types", async () => {
    const cookie = await signIn();
    const run = await liveRun("wallet split");
    const t = await getJson(cookie, `/api/runs/${run.id}/timeline?types=plan.ready,dispatch.started`);
    expect(t.items.map((i: { type: string }) => i.type)).toEqual(["dispatch.started", "plan.ready"]);
    expect(t.total).toBe(2);
  });

  it("the socket sends each event with its model patch, and a watched dispatch's transcript", async () => {
    const cookie = await signIn();
    const run = await liveRun("wallet split");
    const frames: Record<string, any>[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/runs/${run.id}/live`, {
      headers: { cookie },
    } as never);
    ws.onmessage = (m) => void frames.push(JSON.parse(String(m.data)));
    await new Promise<void>((r) => (ws.onopen = () => r()));
    const e = await appendEvent(run, dEnded);
    const ev = await waitFor(() => frames.find((f) => f.kind === "event"));
    expect(ev).toMatchObject({
      kind: "event",
      seq: e.seq,
      type: "dispatch.ended",
      event: { dispatchId: D1 },
    });
    expect(ev.patch.nodes.map((n: { id: string }) => n.id)).toContain("M1/lane/M1.L1");
    expect(ev.patch.seq).toBe(e.seq);

    const dir = dispatchDir(run, D1);
    mkdirSync(dir, { recursive: true });
    const stream = join(dir, "events.jsonl");
    copyFileSync(join(import.meta.dir, "../fixtures/transcript/codex-worker.jsonl"), stream);
    ws.send(JSON.stringify({ watch: D1, from: 0 }));
    const first = await waitFor(() => frames.find((f) => f.kind === "transcript"));
    expect(first).toMatchObject({ kind: "transcript", dispatchId: D1, next: 31 });
    expect(first.items.length).toBeGreaterThan(0);
    appendFileSync(stream, '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n');
    const more = await waitFor(() => frames.find((f) => f.kind === "transcript" && f.next === 32));
    expect(more.items).toHaveLength(1);
    // watching nothing stops it, and an id the run does not know is answered, not tailed
    ws.send(JSON.stringify({ watch: null }));
    ws.send(JSON.stringify({ watch: "d-nope" }));
    const refused = await waitFor(() => frames.find((f) => f.kind === "error"));
    expect(refused).toMatchObject({ code: "E_INPUT_INVALID", dispatchId: "d-nope" });
    ws.send("ping");
    ws.close();
  });

  it("previews a profile change, then saves it only with the document the preview showed", async () => {
    process.env.PATH = "/nonexistent";
    const cookie = await signIn();
    const put = (body: unknown) =>
      call(cookie, "/api/setup/profile", { method: "PUT", body: JSON.stringify(body) });
    const p = await post(cookie, "/api/setup/preview", { patch: { objective: "speed" } });
    const preview = ProfilePreviewSchema.parse(await p.json());
    expect([p.status, preview.saved, preview.diff.map((d) => d.path)]).toEqual([200, false, ["objective"]]);
    const saved = ProfileSavedSchema.parse(
      await (await put({ patch: { objective: "speed" }, expect: preview.expect })).json(),
    );
    expect([saved.saved, saved.diff.map((d) => d.path)]).toEqual([true, ["objective"]]);
    const stale = ProfileSavedSchema.parse(
      await (await put({ patch: { objective: "cost" }, expect: preview.expect })).json(),
    );
    expect([stale.saved, stale.errors[0]?.path]).toEqual([false, CHANGED_ON_DISK]);
    expect((await getJson(cookie, "/api/setup")).settings.objective).toBe("speed");
    expect((await post(cookie, "/api/setup/preview", { patch: { objective: "fast" } })).status).toBe(400);
  });

  it("creates a profile, uses it for the repo, and deletes it", async () => {
    process.env.PATH = "/nonexistent";
    const cookie = await signIn();
    const made = await post(cookie, "/api/profiles", { name: "frugal" });
    expect([made.status, ProfileSavedSchema.parse(await made.json()).saved]).toEqual([200, true]);
    expect(await errorCode(await post(cookie, "/api/profiles", { name: "frugal" }))).toBe("E_INPUT_INVALID");
    expect((await post(cookie, "/api/profiles/frugal/activate", { repo })).status).toBe(204);
    const setup = await getJson(cookie, "/api/setup");
    expect([setup.profile.name, setup.profile.bindings[repo]]).toEqual(["frugal", "frugal"]);
    expect((await call(cookie, "/api/profiles/frugal", { method: "DELETE" })).status).toBe(400);
    expect((await post(cookie, "/api/profiles/default/activate", { repo })).status).toBe(204);
    expect((await call(cookie, "/api/profiles/frugal", { method: "DELETE" })).status).toBe(204);
    expect((await getJson(cookie, "/api/setup")).profile.profiles).not.toContain("frugal");
    expect((await post(cookie, "/api/profiles/default/activate", { repo: "relative" })).status).toBe(400);
    expect((await call(cookie, "/api/setup?repo=relative")).status).toBe(400);
    expect((await getJson(cookie, "/api/setup?repo=global")).repo).toBeNull();
  });

  it("an unknown host makes Setup read-only until the host is set", async () => {
    process.env.PATH = "/nonexistent";
    const dist = mkdtempSync(join(tmpdir(), "catherd-dist-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    const p = servePanel({ deps: defaultDeps(), repo, token: TOKEN, port: 0, distDir: dist, open: false });
    try {
      const login = await fetch(`${p.url}/api/auth/login`, {
        method: "POST",
        body: JSON.stringify({ token: TOKEN }),
      });
      const cookie = (login.headers.get("set-cookie") as string).split(";")[0] as string;
      const at = (path: string, init: RequestInit = {}) =>
        fetch(`${p.url}${path}`, { ...init, headers: { cookie, "content-type": "application/json" } });
      const put = () =>
        at("/api/setup/profile", { method: "PUT", body: JSON.stringify({ patch: {}, expect: {} }) });
      expect(((await (await at("/api/system/version")).json()) as { host: string }).host).toBe("unknown");
      const refused = await put();
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
        "Setup is read-only until the host is known",
      );
      expect((await at("/api/setup")).status).toBe(200);
      const set = await at("/api/setup/host", { method: "POST", body: JSON.stringify({ host: "codex" }) });
      expect(set.status).toBe(204);
      expect(((await (await at("/api/system/version")).json()) as { host: string }).host).toBe("codex");
      expect((await put()).status).toBe(200);
      expect(
        (await at("/api/setup/host", { method: "POST", body: JSON.stringify({ host: "x" }) })).status,
      ).toBe(400);
    } finally {
      await p.stop();
    }
  });

  it("setup reads come from the probe cache; recheck probes again", async () => {
    process.env.PATH = "/nonexistent";
    probeCache.clear();
    const cookie = await signIn();
    await getJson(cookie, "/api/setup");
    const probes = probeCache.probes;
    await getJson(cookie, "/api/setup");
    expect(probeCache.probes).toBe(probes);
    const r = await post(cookie, "/api/setup/recheck", {});
    expect(r.status).toBe(200);
    expect(probeCache.probes).toBeGreaterThan(probes);
  });

  it("sets the notify url, and refuses one that is not http(s)", async () => {
    const cookie = await signIn();
    const put = (url: string) =>
      call(cookie, "/api/setup/notify-url", { method: "PUT", body: JSON.stringify({ url }) });
    expect((await put("https://ntfy.sh/mine")).status).toBe(204);
    expect((await put("ftp://x")).status).toBe(400);
  });

  it("every operation but the sign-in refuses a request without a session", async () => {
    for (const op of OPERATIONS.filter((o) => !o.public)) {
      const r = await fetch(`${base}${op.path.replace(/\{\w+\}/g, "x")}`, { method: op.method });
      expect([op.id, r.status]).toEqual([op.id, 401]);
    }
  });
});
