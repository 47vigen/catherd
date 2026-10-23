import { Alert, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useCallback, useState } from "react";

import type { TimelineEntry } from "../../../client";
import { getRunModelOptions, getRunOptions, getRunTimelineOptions } from "../../../client/@tanstack/react-query.gen";
import { CodeBlock } from "../../../components/code-block/CodeBlock";
import { DataList } from "../../../components/data-list/DataList";
import { SectionLabel } from "../../../components/page-header/PageHeader";
import { errorFix, errorMessage } from "../../../lib/api";
import { type ListSearch, parseListSearch } from "../../../lib/list-search";
import { invalidateOps } from "../../../lib/query";
import { DispatchTable } from "./-components/DispatchTable";
import { NodeDrawer } from "./-components/drawer/NodeDrawer";
import { RunGraph } from "./-components/graph/RunGraph";
import { NodeList } from "./-components/NodeList";
import { RunDocs } from "./-components/RunDocs";
import { RunHeader } from "./-components/RunHeader";
import { Timeline, TimelineFilter } from "./-components/Timeline";
import { useIsDesktop } from "./-hooks/useIsDesktop";
import { useLiveRun } from "./-hooks/useLiveRun";
import { parseTab, type Tab } from "./-lib/tabs";
import { matchesTypes } from "./-lib/timeline-filters";

type RunSearch = ListSearch & { node?: string; attempt?: string; tab?: Tab; types?: string };

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : undefined;

export const Route = createFileRoute("/_app/runs/$runId")({
  validateSearch: (raw: Record<string, unknown>): RunSearch => {
    const node = text(raw.node);
    const attempt = text(raw.attempt);
    const tab = parseTab(raw.tab);
    const types = text(raw.types);
    return {
      ...parseListSearch(raw),
      ...(node ? { node } : {}),
      ...(node && attempt ? { attempt } : {}),
      ...(node && tab ? { tab } : {}),
      ...(types ? { types } : {}),
    };
  },
  component: RunPage,
});

// The detail's state (live entries) belongs to one run: another run remounts it.
function RunPage() {
  const { runId } = Route.useParams();
  return <RunDetail key={runId} runId={runId} />;
}

function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel aside={aside}>{title}</SectionLabel>
      {children}
    </section>
  );
}

function LoadError({ title, error }: { title: string; error: unknown }) {
  return (
    <Alert status="danger" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        <Alert.Description>{errorMessage(error)}</Alert.Description>
        {errorFix(error) ? <CodeBlock lang="text" code={errorFix(error) as string} className="mt-2" /> : null}
      </Alert.Content>
    </Alert>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const { page, pageSize, node, attempt, tab, types } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = Route.useRouteContext({ select: (c) => c.queryClient });
  const isDesktop = useIsDesktop();
  const run = useQuery({ ...getRunOptions({ path: { id: runId } }), refetchInterval: 10_000 });
  const is2 = run.data?.engine === "2.0";
  const live = is2 && run.data?.phase !== "ended";
  const model = useQuery({
    ...getRunModelOptions({ path: { id: runId } }),
    enabled: run.isSuccess,
    refetchInterval: live ? 10_000 : false,
  });
  const timeline = useQuery({
    ...getRunTimelineOptions({
      path: { id: runId },
      query: { limit: pageSize, offset: (page - 1) * pageSize, ...(types ? { types } : {}) },
    }),
    enabled: run.isSuccess,
  });

  // Live entries sit before the fetched ones on page 1; a frame the page already holds is dropped by its seq.
  const [liveEntries, setLiveEntries] = useState<TimelineEntry[]>([]);
  // The socket opens once page 1 is in hand and replays everything after its newest seq (the list is newest first).
  const { isConnected } = useLiveRun(
    runId,
    live === true && page === 1 && timeline.isSuccess,
    (e) => {
      setLiveEntries((all) => (all.some((x) => x.seq === e.seq) ? all : [e, ...all].sort((a, b) => b.seq - a.seq)));
      // The run model is read again on every event until the socket carries the patches itself.
      void invalidateOps(queryClient, "getRun", "getRunModel");
    },
    timeline.data?.items[0]?.seq ?? 0,
  );
  const fetched = timeline.data?.items ?? [];
  const seen = new Set(fetched.map((e) => e.seq));
  const entries =
    page === 1 ? [...liveEntries.filter((e) => !seen.has(e.seq) && matchesTypes(types, e.type)), ...fetched] : fetched;
  const now = new Date(Math.max(run.dataUpdatedAt, timeline.dataUpdatedAt, model.dataUpdatedAt));

  const open = useCallback(
    (id: string) => void navigate({ search: (prev) => ({ ...prev, node: id, tab: "overview", attempt: undefined }) }),
    [navigate],
  );

  if (run.isPending)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  if (run.isError) return <LoadError title="Could not load this run" error={run.error} />;
  const r = run.data;

  return (
    <div className="flex flex-col gap-6">
      <RunHeader run={r} model={model.data} live={live === true} now={now} />
      {is2 ? (
        <Block
          title="Steps"
          aside={
            live ? (
              <output data-connected={isConnected} className="text-muted flex items-center gap-1.5 font-mono text-xs">
                <span
                  aria-hidden="true"
                  className={
                    isConnected
                      ? "bg-success size-1.5 rounded-full motion-safe:animate-pulse"
                      : "bg-muted size-1.5 rounded-full"
                  }
                />
                Live
              </output>
            ) : null
          }
        >
          {model.isPending ? (
            <div className="flex justify-center py-12">
              <Spinner size="sm" />
            </div>
          ) : model.isError ? (
            <LoadError title="Could not load the graph of this run" error={model.error} />
          ) : isDesktop ? (
            <RunGraph model={model.data} selected={node} now={now.getTime()} onOpen={open} />
          ) : (
            <NodeList nodes={model.data.nodes} selected={node} onOpen={open} />
          )}
        </Block>
      ) : (
        <>
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>
                This run started on catherd 1.5. It has no graph; its dispatches, report and timeline are below.
              </Alert.Description>
            </Alert.Content>
          </Alert>
          <Block title="Dispatches">
            <DataList.State
              isLoading={model.isPending}
              error={model.error ?? undefined}
              isEmpty={(model.data?.dispatches.length ?? 0) === 0}
              emptyText="No dispatch was recorded."
            >
              <DispatchTable dispatches={model.data?.dispatches ?? []} />
            </DataList.State>
          </Block>
        </>
      )}
      <Block title={is2 ? "Plan and report" : "Report"}>
        <RunDocs runId={runId} ended={r.phase === "ended" || !is2} only={is2 ? undefined : "report.md"} />
      </Block>
      <Block
        title="Timeline"
        aside={
          <TimelineFilter
            types={types}
            onChange={(t) => void navigate({ search: (prev) => ({ ...prev, page: 1, types: t }) })}
          />
        }
      >
        <DataList.State
          isLoading={timeline.isPending}
          error={timeline.error ?? undefined}
          isEmpty={entries.length === 0}
          emptyText={types ? "No events of this type." : "No events yet."}
        >
          <Timeline entries={entries} now={now} />
        </DataList.State>
        <DataList.Pagination
          page={page}
          pageSize={pageSize}
          total={timeline.data?.total ?? 0}
          onPageChange={(n) => void navigate({ search: (prev) => ({ ...prev, page: n }) })}
          onPageSizeChange={(n) =>
            void navigate({
              search: (prev) => ({ ...prev, page: 1, pageSize: n as ListSearch["pageSize"] }),
              replace: true,
            })
          }
        />
      </Block>
      {is2 && model.data ? (
        <NodeDrawer
          runId={runId}
          run={r}
          model={model.data}
          nodeId={node}
          attemptId={attempt}
          tab={tab ?? "overview"}
          live={live === true}
          now={now.getTime()}
          onChange={(patch) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })}
          onClose={() =>
            void navigate({
              search: (prev) => ({ ...prev, node: undefined, attempt: undefined, tab: undefined }),
              replace: true,
            })
          }
        />
      ) : null}
    </div>
  );
}
