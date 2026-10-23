import { Button } from "@heroui/react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { getDispatchStream } from "../../../../../client";
import { CodeBlock } from "../../../../../components/code-block/CodeBlock";
import { Empty, Loading, QueryError } from "./parts";

const PAGE = 500;

/**
 * The role's stream as the raw JSON lines it wrote, a page at a time. A live role is read again every few seconds,
 * so new lines appear on their own; the readable transcript replaces this view in wave 3.
 */
export function LogTab({ runId, dispatchId, live }: { runId: string; dispatchId: string | null; live: boolean }) {
  const log = useInfiniteQuery({
    queryKey: ["dispatch-log", runId, dispatchId],
    enabled: dispatchId !== null,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const { data } = await getDispatchStream({
        path: { id: runId, dispatchId: dispatchId as string },
        query: { from: pageParam, limit: PAGE, raw: "1" },
        signal,
        throwOnError: true,
      });
      return data;
    },
    getNextPageParam: (last) => ((last.raw?.length ?? 0) >= PAGE ? last.next : undefined),
    refetchInterval: live ? 3000 : false,
  });

  if (dispatchId === null) return <Empty>No log yet.</Empty>;
  if (log.isPending) return <Loading />;
  if (log.isError) return <QueryError error={log.error} title="Could not load the log" />;
  const lines = log.data.pages.flatMap((p) => p.raw ?? []);
  if (lines.length === 0) return <Empty>No log yet.</Empty>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted text-xs">
        {lines.length} {lines.length === 1 ? "line" : "lines"}, as the role wrote them.
      </p>
      <CodeBlock code={lines.join("\n")} lang="json" wrap={false} className="max-h-[60vh]" />
      {log.hasNextPage ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            isPending={log.isFetchingNextPage}
            onPress={() => void log.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
