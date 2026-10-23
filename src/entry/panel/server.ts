import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { CatherdError, errorMessage, isCatherdError } from "../../domain/errors.ts";
import type { OrchestrationHost } from "../../domain/host.ts";
import { tryParseRung } from "../../domain/ids.ts";
import type { ProfileDoc } from "../../domain/profile.ts";
import { deriveRunModel, diffRunModel, type RunModel } from "../../domain/run-graph.ts";
import { describeEvent } from "../../domain/run-events.ts";
import { replay } from "../../domain/run-state.ts";
import { openUrl, writeRedirectPage } from "../../infra/open-url.ts";
import { log } from "../../infra/log.ts";
import { VERSION } from "../../infra/version.ts";
import { cancel } from "../../services/dispatch-service.ts";
import { type NowLine, overview } from "../../services/overview.ts";
import { setupView } from "../../services/panel-setup.ts";
import type { Deps } from "../../services/ports.ts";
import { activate, createProfile, deleteProfile, recordHost } from "../../services/profile-service.ts";
import { answerUnit, cancelRun, pauseRun, resumeRun } from "../../services/run-client.ts";
import { checkLogs, commitDiff, dispatchDetail, dispatchDir, runDoc } from "../../services/run-files.ts";
import { runIndex } from "../../services/run-index.ts";
import { questionContext, runModel } from "../../services/run-model.ts";
import { parkedQuestions, runTimeline, runView, tailEvents } from "../../services/run-read.ts";
import { isDaemonRun, readEvents } from "../../services/run-events-store.ts";
import { findRun, readRecords } from "../../services/run-store.ts";
import { readTranscript, tailTranscript } from "../../services/transcript.ts";
import {
  ActivateBodySchema,
  AnswerBodySchema,
  CreateProfileBodySchema,
  ErrorBodySchema,
  HostBodySchema,
  ListRunsQuerySchema,
  LoginBodySchema,
  NotifyUrlBodySchema,
  OPERATIONS,
  type Operation,
  type OperationId,
  PreviewBodySchema,
  QuestionsQuerySchema,
  SaveProfileBodySchema,
} from "./openapi.ts";

export const PANEL_COOKIE = "catherd_panel";

export interface PanelOptions {
  deps: Deps;
  repo: string | null;
  token: string;
  port: number;
  distDir: string;
  open: boolean;
  /** What opens the sign-in page: a test replaces it. */
  opener?: (target: string) => void;
  pollMs?: number;
}
export interface Panel {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/** 32 random bytes, base64url: the token a `catherd panel` run accepts on its login page. */
export const newToken = (): string => randomBytes(32).toString("base64url");

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

const STATUS: Record<string, number> = {
  E_INPUT_INVALID: 400,
  unauthorized: 401,
  forbidden: 403,
  E_RUN_NOT_FOUND: 404,
  not_found: 404,
  E_RUN_NOT_LIVE: 409,
};

const errorResponse = (code: string, message: string, fix?: string): Response =>
  Response.json(
    ErrorBodySchema.parse({
      error: {
        message,
        type: code,
        code,
        ...(fix === undefined ? {} : { fix }),
      },
    }),
    { status: STATUS[code] ?? 500 },
  );

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
const sameToken = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

const cookieOf = (req: Request): string | undefined =>
  req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === PANEL_COOKIE)?.[1];

/** The first problem of a request, as the 400's message: the field's path, then what is wrong with it. */
const issueText = (e: z.ZodError): string => {
  const i = e.issues[0];
  return i ? `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}` : "invalid request";
};

interface Call {
  deps: Deps;
  repo: string | null;
  params: Record<string, string>;
  query: unknown;
  body: unknown;
  /** Makes `host` the server's host: later calls (and `deps`) read it. */
  setHost(host: OrchestrationHost): void;
}

const page = <T>(all: T[], q: { limit: number; offset: number }) => ({
  items: all.slice(q.offset, q.offset + q.limit),
  total: all.length,
});
const has = (hay: string[], needle: string | undefined): boolean =>
  needle === undefined || hay.some((h) => h.toLowerCase().includes(needle.toLowerCase()));

const DAY = 86_400_000;

/** Ruling 16: no `repo` is the repo the panel started in, `global` the active profile, else an absolute path. */
const repoOf = (c: Call): string | null => {
  const r = (c.query as { repo?: string } | undefined)?.repo;
  if (r === undefined) return c.repo;
  if (r === "global") return null;
  if (!isAbsolute(r))
    throw new CatherdError("E_INPUT_INVALID", `repo: "${r}" is not an absolute path`, {
      fix: 'an absolute path, or "global" for the active profile',
    });
  return r;
};

/** A profile is written only under a known host: the roles' rungs and the agents' links resolve through it. */
const writableHost = (d: Deps): OrchestrationHost => {
  if (d.host.host === "unknown")
    throw new CatherdError("E_INPUT_INVALID", "Setup is read-only until the host is known", {
      fix: "choose the host you work in: POST /api/setup/host",
    });
  return d.host.host;
};

/** The running nodes of a run's model, as the dashboard's "now" lines. A run that cannot be read has none. */
const nowLines = (runId: string): NowLine[] => {
  try {
    return runModel(runId)
      .nodes.filter((n) => n.status === "running")
      .map((n) => ({ node: n.id, title: n.title, text: n.now, rung: n.rung }));
  } catch (e) {
    log("warn", "panel", { run: runId, now: errorMessage(e) });
    return [];
  }
};

/** What a stream needs of a dispatch the run knows: its folder (refused for any other id), backend, end. */
function streamInfo(runId: string, dispatchId: string) {
  const run = findRun(runId);
  const dir = dispatchDir(run, dispatchId);
  const events = readEvents(run);
  const started = events.find((e) => e.type === "dispatch.started" && e.dispatchId === dispatchId);
  const record = readRecords(run).records.find((r) => r.dispatchId === dispatchId);
  const rung = (started?.type === "dispatch.started" ? started.rung : record?.rung) ?? "";
  const ended =
    events.some((e) => e.type === "dispatch.ended" && e.dispatchId === dispatchId) ||
    (started === undefined && record !== undefined);
  return { dir, backend: tryParseRung(rung)?.backend ?? "", ended };
}

/** The run's model as of the events before `seq`: the base of the first patch a socket sends. */
function modelBefore(runId: string, seq: number): RunModel {
  const run = findRun(runId);
  if (!isDaemonRun(run)) return runModel(runId);
  const events = readEvents(run).filter((e) => e.seq < seq);
  return deriveRunModel({
    run: run.id,
    state: replay(events, run.id),
    events,
    records: readRecords(run).records,
  });
}

/** Where a question sits and what the role said; a question whose run cannot say reads as the run's own. */
const contextOf = (run: string, unit: string) => {
  try {
    return questionContext(run, unit);
  } catch (e) {
    log("warn", "panel", { run, unit, context: errorMessage(e) });
    return { node: "start", reply: null, replyName: null, lane: null };
  }
};

const HANDLERS: Record<OperationId, (c: Call) => unknown> = {
  login: () => null,
  logout: () => null,
  getSession: () => ({ authenticated: true }),
  getVersion: (c) => ({ catherd: VERSION, host: c.deps.host.host }),
  getOverview: (c) => {
    const q = c.query as { from?: string; to?: string; repo?: string };
    const to = q.to === undefined ? c.deps.now() : Date.parse(q.to);
    const from = q.from === undefined ? to - 7 * DAY : Date.parse(q.from);
    return overview(c.deps, { from, to, repo: q.repo }, nowLines);
  },
  getSetup: (c) => setupView(c.deps, repoOf(c)),
  recheckSetup: (c) => setupView(c.deps, repoOf(c), { fresh: true }),
  previewProfile: (c) => {
    writableHost(c.deps);
    const { patch } = c.body as z.infer<typeof PreviewBodySchema>;
    if (!c.deps.profiles.preview)
      throw new CatherdError("E_CONFIG_INVALID", "this profile port cannot preview a change");
    return c.deps.profiles.preview(undefined, patch, repoOf(c));
  },
  saveProfile: (c) => {
    writableHost(c.deps);
    const { patch, expect } = c.body as z.infer<typeof SaveProfileBodySchema>;
    return c.deps.profiles.set(undefined, patch, repoOf(c), expect as ProfileDoc);
  },
  setNotifyUrl: (c) => c.deps.profiles.setNotifyUrl((c.body as z.infer<typeof NotifyUrlBodySchema>).url),
  setHost: (c) => {
    const { host } = c.body as z.infer<typeof HostBodySchema>;
    recordHost(host);
    c.setHost(host);
  },
  createProfile: (c) => {
    const { name, from } = c.body as z.infer<typeof CreateProfileBodySchema>;
    return createProfile(name, from, writableHost(c.deps));
  },
  deleteProfile: (c) => {
    writableHost(c.deps);
    deleteProfile(c.params.name as string);
  },
  activateProfile: (c) => {
    const host = writableHost(c.deps);
    const { repo } = c.body as z.infer<typeof ActivateBodySchema>;
    if (repo !== null && !isAbsolute(repo))
      throw new CatherdError("E_INPUT_INVALID", `repo: "${repo}" is not an absolute path`);
    activate(c.params.name as string, repo, host);
  },
  listRuns: (c) => {
    const q = c.query as z.infer<typeof ListRunsQuerySchema>;
    return page(
      runIndex(c.deps, { repo: q.repo }).filter(
        (r) => (q.phase === undefined || r.phase === q.phase) && has([r.title, r.id, r.repo], q.q),
      ),
      q,
    );
  },
  getRun: (c) => runView(c.deps, c.params.id as string),
  getRunModel: (c) => runModel(c.params.id as string),
  getDispatch: (c) => dispatchDetail(findRun(c.params.id as string), c.params.dispatchId as string),
  getDispatchStream: (c) => {
    const q = c.query as { from: number; limit: number; raw: "0" | "1" };
    const { dir, backend, ended } = streamInfo(c.params.id as string, c.params.dispatchId as string);
    return readTranscript(dir, backend, { from: q.from, limit: q.limit, raw: q.raw === "1", ended });
  },
  getRunDoc: (c) => runDoc(findRun(c.params.id as string), (c.query as { name: string }).name),
  getCommitDiff: (c) =>
    commitDiff(findRun(c.params.id as string), c.params.sha as string, {
      lane: (c.query as { lane?: string }).lane,
    }),
  getCheckLogs: (c) => checkLogs(findRun(c.params.id as string), c.params.lane as string),
  // shortcut: reads every event per page, upgrade past ~50k events
  getRunTimeline: (c) => {
    const id = c.params.id as string;
    const q = c.query as { limit: number; offset: number; types?: string };
    if (runView(c.deps, id).engine === "1.5") return { items: [], total: 0 };
    const types = q.types?.split(",").filter(Boolean);
    return page(
      runTimeline(id, 1, Number.MAX_SAFE_INTEGER)
        .filter((e) => !types?.length || types.includes(e.type))
        .toReversed(),
      q,
    );
  },
  cancelRun: (c) => cancelRun(c.deps, { run: c.params.id as string }),
  pauseRun: (c) => pauseRun(c.deps, { run: c.params.id as string }),
  resumeRun: (c) => resumeRun(c.deps, { run: c.params.id as string }),
  cancelRole: async (c) => {
    const name = c.params.name as string;
    const { record } = await cancel(c.deps, c.params.id as string, name);
    return { name, status: record.status };
  },
  answerUnit: (c) =>
    answerUnit(c.deps, {
      run: c.params.id as string,
      ...(c.body as z.infer<typeof AnswerBodySchema>),
    }),
  listQuestions: (c) => {
    const q = c.query as z.infer<typeof QuestionsQuerySchema>;
    const shown = page(
      parkedQuestions({ run: q.run }).filter((p) => has([p.question, p.unit, p.runTitle], q.q)),
      q,
    );
    return { ...shown, items: shown.items.map((p) => ({ ...p, context: contextOf(p.run, p.unit) })) };
  },
  // shortcut: reads every live-or-recent run's events per call, upgrade when the questions page polls fast
  listAnswered: (c) => {
    const q = c.query as { run?: string };
    const since = c.deps.now() - DAY;
    const out: { run: string; runTitle: string; unit: string; answer: string; by: string; at: string }[] = [];
    for (const card of runIndex(c.deps)) {
      if (card.engine === "1.5" || (q.run !== undefined && card.id !== q.run)) continue;
      if (card.endedAt !== null && Date.parse(card.endedAt) < since) continue;
      try {
        for (const e of readEvents(findRun(card.id)))
          if (e.type === "question.answered" && Date.parse(e.at) >= since)
            out.push({
              run: card.id,
              runTitle: card.title,
              unit: e.unit,
              answer: e.answer,
              by: e.by,
              at: e.at,
            });
      } catch (e) {
        log("warn", "panel", { run: card.id, answered: errorMessage(e) });
      }
    }
    return { items: out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20) };
  },
};

const compile = (op: Operation): RegExp => new RegExp(`^${op.path.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`);
const ROUTES = OPERATIONS.map((op) => ({ op, re: compile(op) }));
const LIVE = /^\/api\/runs\/([^/]+)\/live$/;

/** The Host this panel answers to, or null. A browser omits the default port, so port 80 also takes the bare name. */
export const panelHost = (header: string | null, port: number): string | null => {
  const names = ["127.0.0.1", "localhost"];
  const ok = names.flatMap((n) => (port === 80 ? [n, `${n}:80`] : [`${n}:${port}`]));
  return header !== null && ok.includes(header) ? header : null;
};
/** A request without an Origin passes; one with it must come from the page this Host serves. */
export const panelOriginOk = (origin: string | null, host: string): boolean =>
  origin === null || origin === `http://${host}`;

interface SocketData {
  run: string;
  from: number;
  session: string;
  stop?: () => void;
  /** stops the transcript tail the page asked to watch */
  unwatch?: () => void;
}

/** A page asks for one dispatch's stream (`from`: the line to start at), or `null` to stop watching. */
const WatchSchema = z.object({
  watch: z.string().min(1).max(200).nullable(),
  from: z.number().int().min(0).optional(),
});

/** One Bun process on 127.0.0.1: the built files, the JSON API and a socket per run tailing its events. */
export function servePanel(o: PanelOptions): Panel {
  /** `setHost` swaps it: a scoped copy whose profile port reads the new host, as `daemonDeps` does. */
  let deps = o.deps;
  const sessions = new Set<string>();
  const sockets = new Set<ServerWebSocket<SocketData>>();
  /** Ends a session and the run sockets it opened: a socket outlives its cookie otherwise. */
  const revoke = (session: string): void => {
    sessions.delete(session);
    for (const ws of sockets) if (ws.data.session === session) ws.close(4401, "signed out");
  };
  const dist = resolve(o.distDir);
  let origin = "";
  let signInPage: ReturnType<typeof writeRedirectPage> | undefined;
  const dropSignInPage = (): void => {
    signInPage?.remove();
    signInPage = undefined;
  };

  const hostOk = (req: Request): string | null => panelHost(req.headers.get("host"), server.port as number);
  const originOk = (req: Request, host: string): boolean => panelOriginOk(req.headers.get("origin"), host);
  const signedIn = (req: Request): boolean => {
    const c = cookieOf(req);
    return c !== undefined && sessions.has(c);
  };

  const staticFile = (req: Request, rawPath: string): Response => {
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      return errorResponse("not_found", "not found");
    }
    const file = resolve(dist, `.${path}`);
    if (file !== dist && !file.startsWith(dist + sep)) return errorResponse("not_found", "not found");
    const served = existsSync(file) && statSync(file).isFile() ? file : join(dist, "index.html");
    const accepts = req.headers.get("accept-encoding") ?? "";
    for (const [enc, ext] of [
      ["br", ".br"],
      ["gzip", ".gz"],
    ] as const)
      if (new RegExp(`\\b${enc}\\b`).test(accepts) && existsSync(served + ext))
        return new Response(Bun.file(served + ext), {
          headers: {
            ...cache(served),
            "Content-Type": Bun.file(served).type,
            "Content-Encoding": enc,
            Vary: "Accept-Encoding",
          },
        });
    return new Response(Bun.file(served), {
      headers: { ...cache(served), Vary: "Accept-Encoding" },
    });
  };
  const cache = (file: string): Record<string, string> => ({
    "Cache-Control": file.startsWith(join(dist, "assets") + sep)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });

  const api = async (req: Request, url: URL, host: string): Promise<Response> => {
    const hit = ROUTES.map((r) => ({ ...r, m: r.re.exec(url.pathname) })).find(
      (r) => r.m && r.op.method === req.method,
    );
    if (!hit?.m) return errorResponse("not_found", "not found");
    const { op } = hit;
    if (!op.public && !signedIn(req)) return errorResponse("unauthorized", "sign in first");
    if (op.method !== "GET" && !originOk(req, host))
      return errorResponse("forbidden", "cross-origin request refused");
    let params: Record<string, string>;
    try {
      params = Object.fromEntries(
        Object.entries(hit.m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]),
      );
    } catch {
      return errorResponse("E_INPUT_INVALID", "the request path has a malformed escape");
    }
    let query: unknown;
    let body: unknown;
    if (op.query) {
      const r = op.query.safeParse(Object.fromEntries(url.searchParams));
      if (!r.success) return errorResponse("E_INPUT_INVALID", issueText(r.error));
      query = r.data;
    }
    if (op.body) {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return errorResponse("E_INPUT_INVALID", "the request body is not valid JSON");
      }
      const r = op.body.safeParse(raw);
      if (!r.success) return errorResponse("E_INPUT_INVALID", issueText(r.error));
      body = r.data;
    }
    try {
      if (op.id === "login") {
        if (!sameToken((body as z.infer<typeof LoginBodySchema>).token, o.token))
          return errorResponse("unauthorized", "wrong token");
        const session = randomBytes(32).toString("base64url");
        sessions.add(session);
        dropSignInPage();
        return new Response(null, {
          status: 204,
          headers: {
            "Set-Cookie": `${PANEL_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
          },
        });
      }
      if (op.id === "logout") {
        const c = cookieOf(req);
        if (c) revoke(c);
        return new Response(null, {
          status: 204,
          headers: {
            "Set-Cookie": `${PANEL_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/`,
          },
        });
      }
      const out = await HANDLERS[op.id]({
        deps,
        repo: o.repo,
        params,
        query,
        body,
        setHost: (host) => {
          const scoped: Deps = { ...deps, host: { host, session: null, conflict: null } };
          scoped.profiles = deps.profiles.withHost?.(() => scoped.host) ?? deps.profiles;
          deps = scoped;
        },
      });
      return op.response === null
        ? new Response(null, { status: 204 })
        : Response.json(op.response.parse(out));
    } catch (e) {
      if (isCatherdError(e)) return errorResponse(e.code, e.message, e.fix);
      return errorResponse("internal", errorMessage(e));
    }
  };

  const fetch = async (req: Request, srv: Bun.Server<SocketData>): Promise<Response | undefined> => {
    const host = hostOk(req);
    if (host === null) return withHeaders(errorResponse("forbidden", "this panel answers on 127.0.0.1 only"));
    // the raw target, not URL's normalised one: a `%2e%2e` segment must reach the path check
    const target = req.url.replace(/^[a-z]+:\/\/[^/]+/i, "");
    const [rawPath = "/"] = target.split("?");
    const url = new URL(req.url);
    const live = LIVE.exec(url.pathname);
    if (live && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const session = cookieOf(req);
      if (session === undefined || !sessions.has(session))
        return withHeaders(errorResponse("unauthorized", "sign in first"));
      if (!originOk(req, host)) return withHeaders(errorResponse("forbidden", "cross-origin socket refused"));
      let id: string;
      try {
        id = decodeURIComponent(live[1] as string);
      } catch {
        return withHeaders(errorResponse("E_INPUT_INVALID", "the request path has a malformed escape"));
      }
      try {
        findRun(id);
      } catch (e) {
        return withHeaders(
          isCatherdError(e)
            ? errorResponse(e.code, e.message, e.fix)
            : errorResponse("internal", errorMessage(e)),
        );
      }
      // no `from`: only what is appended from now on (the page loads the history over HTTP)
      const asked = url.searchParams.get("from");
      const from =
        asked === null
          ? (readEvents(findRun(id)).at(-1)?.seq ?? 0) + 1
          : Math.max(1, Number.parseInt(asked, 10) || 1);
      if (srv.upgrade(req, { data: { run: id, from, session } })) return undefined;
      return withHeaders(errorResponse("E_INPUT_INVALID", "not a websocket upgrade"));
    }
    if (url.pathname.startsWith("/api/")) return withHeaders(await api(req, url, host));
    return withHeaders(staticFile(req, rawPath));
  };

  const withHeaders = (r: Response): Response => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
    return r;
  };

  let server: Bun.Server<SocketData>;
  try {
    server = Bun.serve<SocketData>({
      hostname: "127.0.0.1",
      port: o.port,
      fetch,
      websocket: {
        open(ws: ServerWebSocket<SocketData>) {
          sockets.add(ws);
          const { run: id, from } = ws.data;
          // one model per poll batch: the batch's last frame carries the patch for all of it
          let prev: RunModel | null = null;
          try {
            prev = modelBefore(id, from);
          } catch (e) {
            log("warn", "panel", { run: id, socket: errorMessage(e) });
          }
          ws.data.stop = tailEvents(
            findRun(id),
            from,
            (e, last) => {
              let patch: ReturnType<typeof diffRunModel> | null | undefined;
              if (last)
                try {
                  const next = runModel(id);
                  patch = prev ? diffRunModel(prev, next) : null;
                  prev = next;
                } catch (err) {
                  // a null patch tells the page to refetch the model
                  log("warn", "panel", { run: id, seq: e.seq, patch: errorMessage(err) });
                  patch = null;
                  prev = null;
                }
              ws.send(
                JSON.stringify({
                  kind: "event",
                  seq: e.seq,
                  at: e.at,
                  type: e.type,
                  text: describeEvent(e),
                  event: e,
                  patch,
                }),
              );
            },
            { pollMs: o.pollMs },
          );
        },
        close(ws: ServerWebSocket<SocketData>) {
          sockets.delete(ws);
          ws.data.stop?.();
          ws.data.unwatch?.();
        },
        // `{"watch": dispatchId, "from": line}` tails that dispatch's stream, `{"watch": null}` stops; a `ping`
        // frame keeps the tab's socket warm and means nothing
        message(ws: ServerWebSocket<SocketData>, raw) {
          let asked: z.infer<typeof WatchSchema>;
          try {
            asked = WatchSchema.parse(JSON.parse(String(raw)));
          } catch {
            return;
          }
          ws.data.unwatch?.();
          ws.data.unwatch = undefined;
          if (asked.watch === null) return;
          const dispatchId = asked.watch;
          try {
            const { dir, backend } = streamInfo(ws.data.run, dispatchId);
            ws.data.unwatch = tailTranscript(
              dir,
              backend,
              asked.from ?? 0,
              (p) => ws.send(JSON.stringify({ kind: "transcript", dispatchId, ...p })),
              { pollMs: o.pollMs },
            );
          } catch (e) {
            ws.send(
              JSON.stringify({
                kind: "error",
                dispatchId,
                code: isCatherdError(e) ? e.code : "internal",
                message: errorMessage(e),
              }),
            );
          }
        },
      },
    });
  } catch (e) {
    if (/in use|EADDRINUSE/i.test(errorMessage(e)))
      throw new CatherdError("E_INPUT_INVALID", `port ${o.port} is in use`, {
        fix: "catherd panel --port 0 (any free port)",
      });
    throw e;
  }
  origin = `http://127.0.0.1:${server.port}`;
  if (o.open) {
    signInPage = writeRedirectPage(`${origin}/login#token=${o.token}`);
    (o.opener ?? openUrl)(signInPage.path);
  }
  return {
    url: origin,
    port: server.port as number,
    stop: async () => {
      dropSignInPage();
      await server.stop(true);
    },
  };
}
