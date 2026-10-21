import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { brotliCompressSync } from "node:zlib";
import { dirname, join } from "node:path";
import { defaultDeps } from "../../src/entry/deps.ts";
import { type Panel, PANEL_COOKIE, servePanel } from "../../src/entry/panel/server.ts";
import { ProfileSavedSchema } from "../../src/services/panel-setup.ts";
import { daemonLauncher } from "../../src/services/daemon.ts";
import { runStart } from "../../src/services/run-client.ts";
import { RunViewSchema, runTimeline } from "../../src/services/run-read.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import { createRun, findRun } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
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
    expect(frames[0]).toEqual(runTimeline(id, e.seq, 1)[0]);
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
