import type { QueryClient } from "@tanstack/react-query";

/**
 * Invalidates every cached query generated for the given operation ids. The generated query keys start with an
 * object whose `_id` is the operationId, so this matches every page and filter of a list at once.
 */
export function invalidateOps(qc: QueryClient, ...operationIds: string[]): Promise<void> {
  const ids = new Set(operationIds);
  return qc.invalidateQueries({
    predicate: (q) => {
      const head = q.queryKey[0];
      if (typeof head !== "object" || head === null) return false;
      const id = (head as { _id?: unknown })._id;
      return typeof id === "string" && ids.has(id);
    },
  });
}
