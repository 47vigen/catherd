import { CatherdError } from "../domain/errors.ts";
import type { RoleScope } from "../domain/role-scope.ts";
import { roleMcpTools } from "../domain/role-tools.ts";
import { latestDispatch } from "./dispatches.ts";
import { findRun } from "./run-store.ts";

/**
 * Spec 1.5 plan 21: what the role server lets a role do, for the CLI forms any role can run
 * (`catherd run-file`, `catherd gate`). Outside a role (`scope` null: the user's own terminal) everything is
 * allowed. In a role, only its own run, and only the operations its role server would list (`tool`).
 */
export function assertRoleMay(scope: RoleScope | null, run: string, tool: string): void {
  if (!scope) return;
  if (scope.run !== run)
    throw new CatherdError(
      "E_ROLE_SCOPE",
      `this process runs ${scope.name} of run ${scope.run}, not of run ${run}`,
      { fix: `use run ${scope.run}` },
    );
  const role = latestDispatch(findRun(run), scope.name)?.admit.role;
  if (!role || !roleMcpTools(role).includes(tool))
    throw new CatherdError(
      "E_ROLE_SCOPE",
      `${scope.name} ${role ? `is a ${role}, which has no ${tool}` : `is no dispatch of run ${run}`}`,
      { fix: "report it in your reply; the orchestrator does it" },
    );
}
