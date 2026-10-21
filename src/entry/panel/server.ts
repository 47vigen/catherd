import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { CatherdError, errorMessage, isCatherdError } from "../../domain/errors.ts";
import { describeEvent } from "../../domain/run-events.ts";
import { ROLES, type Role } from "../../domain/roles.ts";
import { openUrl, writeRedirectPage } from "../../infra/open-url.ts";
import { VERSION } from "../../infra/version.ts";
import { setRoleRungs, setupView } from "../../services/panel-setup.ts";
import type { Deps } from "../../services/ports.ts";
import { answerUnit, cancelRun } from "../../services/run-client.ts";
import { listRunViews, parkedQuestions, runTimeline, runView, tailEvents } from "../../services/run-read.ts";
import { readEvents } from "../../services/run-events-store.ts";
import { findRun } from "../../services/run-store.ts";
import {
  AnswerBodySchema,
  ErrorBodySchema,
  ListRunsQuerySchema,
  LoginBodySchema,
  OPERATIONS,
  type Operation,
  type OperationId,
  QuestionsQuerySchema,
  RungsBodySchema,
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
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
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
}

const page = <T>(all: T[], q: { limit: number; offset: number }) => ({
  items: all.slice(q.offset, q.offset + q.limit),
  total: all.length,
});
const has = (hay: string[], needle: string | undefined): boolean =>
  needle === undefined || hay.some((h) => h.toLowerCase().includes(needle.toLowerCase()));

const HANDLERS: Record<OperationId, (c: Call) => unknown> = {
  login: () => null,
  logout: () => null,
  getSession: () => ({ authenticated: true }),
  getVersion: () => ({ catherd: VERSION }),
  getSetup: (c) => setupView(c.deps, c.repo),
  setRoleRungs: (c) => {
    const role = c.params.role as Role;
    if (!ROLES.includes(role))
      throw new CatherdError("E_INPUT_INVALID", `no role named "${role}"`, {
        fix: `one of ${ROLES.join(", ")}`,
      });
    return setRoleRungs(c.deps, c.repo, role, (c.body as z.infer<typeof RungsBodySchema>).rungs);
  },
  // shortcut: reads every run's view per list call, upgrade when a home holds thousands of runs
  listRuns: (c) => {
    const q = c.query as z.infer<typeof ListRunsQuerySchema>;
    const all = listRunViews(c.deps, { limit: 100_000 }).filter(
      (r) => (q.phase === undefined || r.phase === q.phase) && has([r.title, r.id, r.repo], q.q),
    );
    return page(all, q);
  },
  getRun: (c) => runView(c.deps, c.params.id as string),
  // shortcut: reads every event per page, upgrade past ~50k events
  getRunTimeline: (c) => {
    const id = c.params.id as string;
    if (runView(c.deps, id).engine === "1.5") return { items: [], total: 0 };
    return page(
      runTimeline(id, 1, Number.MAX_SAFE_INTEGER).toReversed(),
      c.query as { limit: number; offset: number },
    );
  },
  cancelRun: (c) => cancelRun(c.deps, { run: c.params.id as string }),
  answerUnit: (c) =>
    answerUnit(c.deps, {
      run: c.params.id as string,
      ...(c.body as z.infer<typeof AnswerBodySchema>),
    }),
  listQuestions: (c) => {
    const q = c.query as z.infer<typeof QuestionsQuerySchema>;
    return page(
      parkedQuestions({ run: q.run }).filter((p) => has([p.question, p.unit, p.runTitle], q.q)),
      q,
    );
  },
};

const compile = (op: Operation): RegExp => new RegExp(`^${op.path.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`);
const ROUTES = OPERATIONS.map((op) => ({ op, re: compile(op) }));
const LIVE = /^\/api\/runs\/([^/]+)\/live$/;

interface SocketData {
  run: string;
  from: number;
  stop?: () => void;
}

/** One Bun process on 127.0.0.1: the built files, the JSON API and a socket per run tailing its events. */
export function servePanel(o: PanelOptions): Panel {
  const sessions = new Set<string>();
  const dist = resolve(o.distDir);
  let origin = "";
  let signInPage: ReturnType<typeof writeRedirectPage> | undefined;
  const dropSignInPage = (): void => {
    signInPage?.remove();
    signInPage = undefined;
  };

  const hostOk = (req: Request): string | null => {
    const host = req.headers.get("host");
    return host === `127.0.0.1:${server.port}` || host === `localhost:${server.port}` ? host : null;
  };
  const originOk = (req: Request, host: string): boolean => {
    const from = req.headers.get("origin");
    return from === null || from === `http://${host}`;
  };
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
        if (c) sessions.delete(c);
        return new Response(null, {
          status: 204,
          headers: {
            "Set-Cookie": `${PANEL_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/`,
          },
        });
      }
      const out = await HANDLERS[op.id]({
        deps: o.deps,
        repo: o.repo,
        params,
        query,
        body,
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
      if (!signedIn(req)) return withHeaders(errorResponse("unauthorized", "sign in first"));
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
      if (srv.upgrade(req, { data: { run: id, from } })) return undefined;
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
          ws.data.stop = tailEvents(
            findRun(ws.data.run),
            ws.data.from,
            (e) =>
              ws.send(
                JSON.stringify({
                  seq: e.seq,
                  at: e.at,
                  type: e.type,
                  text: describeEvent(e),
                }),
              ),
            { pollMs: o.pollMs },
          );
        },
        close(ws: ServerWebSocket<SocketData>) {
          ws.data.stop?.();
        },
        // a `ping` frame keeps the tab's socket warm and means nothing
        message() {},
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
