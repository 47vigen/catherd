import { CatherdError } from "./errors.ts";
import { ID_PATTERN } from "./ids.ts";

/**
 * Spec 1.5 plan 21: the env var the supervisor sets in every role's process, `<run>/<role-name>`. A process
 * that carries it is a role of that run: it never owns the run and never reaches the coordinator tools.
 */
export const ROLE_ENV = "CATHERD_ROLE";

/** The run and the dispatch name a role process works for. */
export interface RoleScope {
  run: string;
  name: string;
}

const isId = (s: string): boolean => ID_PATTERN.test(s) && !s.includes("..");

export const formatRoleScope = (s: RoleScope): string => `${s.run}/${s.name}`;

/** `<run>/<role-name>`, else null (unset, empty, or not two ids). */
export function parseRoleScope(value: string | undefined): RoleScope | null {
  if (!value) return null;
  const [run, name, ...rest] = value.split("/");
  if (rest.length > 0 || !run || !name || !isId(run) || !isId(name)) return null;
  return { run, name };
}

/** A run id as `createRun` makes it: `YYYYMMDD-HHMMSS-<slug>`. */
const RUN_ID = /^\d{8}-\d{6}-/;

/**
 * The role a temp dir names, when it is a role's scratch, `…/runs/<run>/scratch/<name>[/…]`: Codex passes an
 * MCP server only a short list of env vars, TMPDIR among them and CATHERD_ROLE not, so a server a role's
 * Codex starts knows it is a role by its TMPDIR.
 */
export function roleScopeOfScratch(tmpdir: string | undefined): RoleScope | null {
  if (!tmpdir) return null;
  const parts = tmpdir.split(/[\\/]+/).filter(Boolean);
  for (let i = parts.length - 2; i >= 2; i--) {
    if (parts[i] !== "scratch" || parts[i - 2] !== "runs") continue;
    const run = parts[i - 1] as string;
    const name = parts[i + 1] as string;
    if (RUN_ID.test(run)) return parseRoleScope(`${run}/${name}`);
  }
  return null;
}

/** The role this process works for: CATHERD_ROLE, else a TMPDIR that is a role's scratch, else null. */
export function roleScopeFromEnv(env: Record<string, string | undefined>): RoleScope | null {
  return parseRoleScope(env[ROLE_ENV]) ?? roleScopeOfScratch(env.TMPDIR);
}

/**
 * The tools only the orchestrator calls: each one claims the run, steers a role or changes the run's plan
 * (spec 1.5 plan 21). A role process gets E_ROLE_SCOPE for them.
 */
export const COORDINATOR_TOOLS = [
  "peek",
  "result",
  "dispatch",
  "run_start",
  "climb",
  "land",
  "park",
  "cancel",
  "set_next",
  "answer",
  "profile_set",
  "workspace_start",
  "workspace_contract",
  "workspace_child_start",
  "test_push",
  "workspace_budget",
] as const;

const COORDINATOR = new Set<string>(COORDINATOR_TOOLS);

export const isCoordinatorTool = (tool: string): boolean => COORDINATOR.has(tool);

/**
 * Whether a role process may not make this call: every coordinator tool, except a `peek` of its own
 * dispatch (its run and its own name) and a `workspace_contract` read (no `content`).
 */
export function refusedForRole(tool: string, args: unknown, scope: RoleScope): boolean {
  if (!COORDINATOR.has(tool)) return false;
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === "peek") return !(a.run === scope.run && a.name === scope.name);
  if (tool === "workspace_contract") return a.content !== undefined;
  return true;
}

/** E_ROLE_SCOPE: the error a role process gets for a coordinator tool, with the line that fixes it. */
export function roleScopeError(tool: string, scope: RoleScope): CatherdError {
  return new CatherdError(
    "E_ROLE_SCOPE",
    `${tool} is the orchestrator's: this process runs ${scope.name} of run ${scope.run}`,
    {
      fix: `a role reports through its reply; read its run's files with read_run_file, or catherd run-file read ${scope.run} <path>`,
    },
  );
}
