import { noRungCause, rolesWithoutRung } from "../domain/select.ts";
import { catalogQuery, startIndex } from "./catalog-service.ts";
import type { RoutingPort } from "./ports.ts";

/**
 * The routing port over the catalog (spec §5). Plan 49, spec D7: the profile's ladders pick the rung, so routing
 * only checks a run's start and answers catalog queries.
 */
export function routingService(): RoutingPort {
  return {
    checkStart: async (view, repo) => {
      const { catalog, index } = await startIndex(repo);
      const unusable = rolesWithoutRung(catalog, view);
      return {
        unusable,
        causes: Object.fromEntries(unusable.map((role) => [role, noRungCause(catalog, view, role)])),
        index,
      };
    },
    catalog: (filter, billing) => catalogQuery(filter, billing),
  };
}
