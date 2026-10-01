import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { HostContext } from "../../domain/host.ts";
import { errorMessage } from "../../domain/errors.ts";
import { resolveHost } from "../../infra/host-context.ts";
import { log } from "../../infra/log.ts";
import { startNotifier } from "../../services/notifier.ts";
import type { Deps } from "../../services/ports.ts";
import { reconcileAll } from "../../services/reconcile.ts";
import { backgroundSync } from "../../services/source-sync.ts";
import { defaultDeps } from "../deps.ts";
import { registerDispatchTools } from "./dispatch-tools.ts";
import { registerLaneTools } from "./lane-tools.ts";
import { registerProtocolTools } from "./protocol-tools.ts";
import { sdkToolError, toolOf } from "./result.ts";
import { registerRunTools } from "./run-tools.ts";
import { registerSetupTools } from "./setup-tools.ts";

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

/** Spec §10.2: every tool call is logged with its duration and outcome (the error code), never its input. */
function logToolCalls(
  server: McpServer,
  deps: Deps,
  scope: AsyncLocalStorage<Deps>,
  generation: () => number,
): void {
  const register = server.registerTool.bind(server) as unknown as (
    n: string,
    c: unknown,
    h: Handler,
  ) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, handler) =>
    register(name, config, async (...args: unknown[]) => {
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
      const r = await scope.run(
        {
          ...deps,
          get host(): HostContext {
            return epoch === generation() ? host : { host: "unknown", session: null, conflict: null };
          },
        },
        () => handler(...args),
      );
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

export function buildServer(deps: Deps = defaultDeps()): McpServer {
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
  logToolCalls(server, deps, scope, () => generation);
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
  registerLaneTools(server, scoped);
  registerDispatchTools(server, scoped);
  registerSetupTools(server, scoped);
  registerProtocolTools(server, scoped);
  return server;
}

/** Connect immediately; initialized triggers recovery without delaying the handshake. */
export async function startMcpServer(
  o: { transport?: Transport; sync?: () => Promise<unknown>; deps?: Deps } = {},
): Promise<void> {
  const deps = o.deps ?? defaultDeps();
  const server = buildServer(deps);
  const initialized = server.server.oninitialized!;
  const closed = server.server.onclose!;
  let generation = 0;
  let notifier: ReturnType<typeof startNotifier> | undefined;
  let recovery: Deps | undefined;
  const invalidate = () => {
    generation++;
    if (recovery) recovery.host = { host: "unknown", session: null, conflict: null };
    notifier?.stop();
    notifier = undefined;
    closed();
  };
  server.server.onclose = invalidate;
  server.server.oninitialized = () => {
    invalidate();
    initialized();
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
    void Promise.resolve()
      .then(() => {
        if (epoch === generation) return (o.sync ?? (() => backgroundSync()))();
      })
      .catch((e: unknown) => log("debug", "sources", { error: errorMessage(e) }));
    void (async () => {
      try {
        if (epoch !== generation) return;
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
