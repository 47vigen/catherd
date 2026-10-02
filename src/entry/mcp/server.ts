import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { sessionKey, type HostContext } from "../../domain/host.ts";
import { type CatherdError, errorMessage, isCatherdError } from "../../domain/errors.ts";
import {
  isCoordinatorTool,
  refusedForRole,
  type RoleScope,
  roleScopeError,
} from "../../domain/role-scope.ts";
import { takeBootLock } from "../../infra/boot-lock.ts";
import { resolveHost } from "../../infra/host-context.ts";
import { log } from "../../infra/log.ts";
import { assertRoleMay } from "../../services/role-access.ts";
import { currentSession } from "../../services/sessions.ts";
import { startNotifier } from "../../services/notifier.ts";
import type { Deps } from "../../services/ports.ts";
import { reconcileAll } from "../../services/reconcile.ts";
import { backgroundSync } from "../../services/source-sync.ts";
import { defaultDeps } from "../deps.ts";
import { registerDispatchTools } from "./dispatch-tools.ts";
import { registerLaneTools } from "./lane-tools.ts";
import { registerProtocolTools } from "./protocol-tools.ts";
import { registerPushTools } from "./push-tools.ts";
import { handle, sdkToolError, toolOf } from "./result.ts";
import { registerRunTools } from "./run-tools.ts";
import { registerSetupTools } from "./setup-tools.ts";
import { registerWorkspaceTools } from "./workspace-tools.ts";

type ObserveSession = (context: Deps) => (() => void) | undefined;

/** Spec 1.5 plan 21: a coordinator tool's description says, first, that only the orchestrator calls it. */
function orchestratorOnly(name: string, config: unknown): unknown {
  const c = config as { description?: string };
  return isCoordinatorTool(name) && c.description
    ? { ...c, description: `Orchestrator only (a role process gets E_ROLE_SCOPE). ${c.description}` }
    : config;
}

type RequestHandler = (
  request: { params?: { name?: unknown; arguments?: unknown } },
  extra: unknown,
) => unknown;

/** The role server's tools that act on a run: in a role they are bound as their CLI forms are (assertRoleMay). */
const RUN_BOUND_TOOLS = new Set(["read_run_file", "write_run_file", "gate_check", "gate_pass"]);

/**
 * Why a role process may not make this call on the full server, else null (plan 21 review, finding 3): a
 * coordinator tool; `record_agent_run`, which could fabricate a verifier's ok; or a run-bound tool on another
 * run or outside its role's tool set, as `catherd run-file` and `catherd gate` refuse it.
 */
function roleRefusal(name: string, args: unknown, role: RoleScope): CatherdError | null {
  if (refusedForRole(name, args, role) || name === "record_agent_run") return roleScopeError(name, role);
  if (!RUN_BOUND_TOOLS.has(name)) return null;
  const run = (args as { run?: unknown } | undefined)?.run;
  try {
    assertRoleMay(role, typeof run === "string" ? run : "", name);
    return null;
  } catch (e) {
    if (isCatherdError(e)) return e;
    throw e;
  }
}

/**
 * Spec 1.5 plan 21: in a role's process (`deps.role`) a coordinator tool call is refused with E_ROLE_SCOPE
 * before anything else, its input check included, so a role learns at once that the tool is not its own. The
 * SDK keeps its request handlers in a private map; test/entry/role-scope-mcp.test.ts fails if it moves.
 */
function refuseCoordinatorTools(server: McpServer, deps: Deps): void {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, RequestHandler> })
    ._requestHandlers;
  const callTool = handlers.get("tools/call");
  if (!callTool) return;
  handlers.set("tools/call", async (request, extra) => {
    const role = deps.role;
    const name = String(request.params?.name ?? "");
    const refusal = role ? roleRefusal(name, request.params?.arguments, role) : null;
    if (!refusal) return callTool(request, extra);
    const r = await handle(() => {
      throw refusal;
    });
    log("warn", "tool", { tool: name, ok: false, code: "E_ROLE_SCOPE" });
    return r;
  });
}

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

/** Spec §10.2: every tool call is logged with its duration and outcome (the error code), never its input. */
function logToolCalls(
  server: McpServer,
  deps: Deps,
  scope: AsyncLocalStorage<Deps>,
  generation: () => number,
  observe?: ObserveSession,
): void {
  const register = server.registerTool.bind(server) as unknown as (
    n: string,
    c: unknown,
    h: Handler,
  ) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, handler) =>
    register(name, orchestratorOnly(name, config), async (...args: unknown[]) => {
      const started = Date.now();
      const epoch = generation();
      const extra = args.at(-1) as { _meta?: Record<string, unknown> } | undefined;
      let host = deps.host;
      if (host.host === "codex" && !host.conflict && extra?._meta && "threadId" in extra._meta) {
        const threadId = extra._meta.threadId;
        host =
          typeof threadId === "string"
            ? resolveHost({
                clientName: "codex-mcp-client",
                env: { CODEX_THREAD_ID: threadId, CODEX_SESSION_ID: host.session?.sessionId },
              })
            : { host: "unknown", session: null, conflict: "Codex _meta.threadId must be a UUID string" };
      }
      const context: Deps = {
        ...deps,
        get host(): HostContext {
          return epoch === generation() ? host : { host: "unknown", session: null, conflict: null };
        },
      };
      const after = observe?.(context);
      const r = await scope.run(context, () => handler(...args));
      after?.();
      const code = r.isError ? (r.structuredContent as { code?: string } | undefined)?.code : undefined;
      log(r.isError ? "warn" : "info", "tool", {
        tool: name,
        ms: Date.now() - started,
        ok: !r.isError,
        code,
      });
      return r;
    });
}

export function buildServer(deps: Deps = defaultDeps(), observe?: ObserveSession): McpServer {
  const server = new McpServer({ name: "catherd", version: deps.version });
  const scope = new AsyncLocalStorage<Deps>();
  const scoped: Deps = new Proxy(deps, {
    get: (target, key) => (key === "profiles" ? profiles : Reflect.get(scope.getStore() ?? target, key)),
  });
  const profiles = deps.profiles.withHost?.(() => scoped.host) ?? deps.profiles;
  let generation = 0;
  const invalidate = () => {
    generation++;
    deps.host = { host: "unknown", session: null, conflict: null };
  };
  logToolCalls(server, deps, scope, () => generation, observe);
  deps.host = { host: "unknown", session: null, conflict: null };
  server.server.oninitialized = () => {
    invalidate();
    deps.host = resolveHost({ clientName: server.server.getClientVersion()?.name, env: process.env });
  };
  server.server.onclose = invalidate;
  // The SDK validates input before a tool's `handle` runs and reports a failure through this (private)
  // method as plain text; test/entry/mcp.test.ts fails loudly if an SDK upgrade renames it. The wrapper
  // above never sees such a call, so it is logged here (spec §10.2: every call), by the tool it names.
  (server as unknown as { createToolError: typeof sdkToolError }).createToolError = (message) => {
    const r = sdkToolError(message);
    const code = (r.structuredContent as { code?: string } | undefined)?.code;
    log("warn", "tool", { tool: toolOf(message), ok: false, code });
    return r;
  };
  registerRunTools(server, scoped);
  registerWorkspaceTools(server, scoped);
  registerLaneTools(server, scoped);
  registerDispatchTools(server, scoped);
  registerSetupTools(server, scoped);
  registerProtocolTools(server, scoped);
  registerPushTools(server, scoped);
  refuseCoordinatorTools(server, deps);
  return server;
}

/** Connect immediately; initialized triggers recovery without delaying the handshake. */
export async function startMcpServer(
  o: {
    transport?: Transport;
    sync?: () => Promise<unknown>;
    deps?: Deps;
    /** plan 22: the boot lock (tests replace it); null while another live server holds it */
    bootLock?: () => (() => void) | null;
  } = {},
): Promise<void> {
  const deps = o.deps ?? defaultDeps();
  const observed = new Map<string, ReturnType<typeof startNotifier>>();
  const server = buildServer(deps, (context) => {
    const target = currentSession(context);
    if (!target) return;
    const key = sessionKey(target);
    let active = observed.get(key);
    if (!active) {
      active = startNotifier(context);
      observed.set(key, active);
    }
    const n = active;
    return () => {
      if (observed.get(key) === n) void n.scan();
    };
  });
  const initialized = server.server.oninitialized!;
  const closed = server.server.onclose!;
  let generation = 0;
  let notifier: ReturnType<typeof startNotifier> | undefined;
  let recovery: Deps | undefined;
  // plan 22: taken at the first initialize, held until this server closes; null: another server leads the boot
  let boot: (() => void) | null | undefined;
  const invalidate = () => {
    generation++;
    if (recovery) recovery.host = { host: "unknown", session: null, conflict: null };
    notifier?.stop();
    notifier = undefined;
    for (const n of observed.values()) n.stop();
    observed.clear();
    closed();
  };
  server.server.onclose = () => {
    invalidate();
    boot?.();
    boot = undefined;
  };
  server.server.oninitialized = () => {
    invalidate();
    initialized();
    boot ??= (o.bootLock ?? takeBootLock)();
    const lead = boot !== null;
    if (!lead) log("info", "boot", { skipped: "another catherd server runs the boot sync and reconcile" });
    log("info", "session", {
      host: deps.host.host,
      conflict: deps.host.conflict,
      sessionId: Boolean(deps.session?.sessionId),
      hostSessionId: Boolean(deps.session?.hostSessionId),
      socket: Boolean(deps.session?.socketPath),
      token: Boolean(deps.session?.token),
    });
    const epoch = generation;
    recovery = { ...deps };
    const context = recovery;
    notifier = startNotifier(context);
    const active = notifier;
    const target = currentSession(context);
    if (target) observed.set(sessionKey(target), active);
    void Promise.resolve()
      .then(() => {
        if (lead && epoch === generation) return (o.sync ?? (() => backgroundSync()))();
      })
      .catch((e: unknown) => log("debug", "sources", { error: errorMessage(e) }));
    void (async () => {
      try {
        if (epoch !== generation) return;
        // the leading server reconciles every run; this one still tells its own session what it owns
        if (!lead) return void active.scan();
        const r = await reconcileAll(context);
        if (epoch !== generation) return;
        const shown = r.warnings.length;
        for (const w of r.warnings) console.error(`catherd: ${w}`);
        void r.done.then(() => {
          if (epoch === generation) for (const w of r.warnings.slice(shown)) console.error(`catherd: ${w}`);
        });
        if (epoch === generation) void active.scan();
      } catch (e) {
        console.error(`catherd: reconcile failed: ${errorMessage(e)}`);
      }
    })();
  };
  await server.connect(o.transport ?? new StdioServerTransport());
}
