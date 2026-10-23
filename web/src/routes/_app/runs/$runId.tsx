import { Alert, cn, Spinner } from "@heroui/react";
import { replaceEqualDeep, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RunModel, TimelineEntry } from "../../../client";
import {
  getRunModelOptions,
  getRunModelQueryKey,
  getRunOptions,
  getRunQueryKey,
  getRunTimelineOptions,
} from "../../../client/@tanstack/react-query.gen";
import { CodeBlock } from "../../../components/code-block/CodeBlock";
import { DataList } from "../../../components/data-list/DataList";
import { Tile } from "../../../components/tile/Tile";
import { errorFix, errorMessage } from "../../../lib/api";
import { type ListSearch, parseListSearch, stripListDefaults } from "../../../lib/list-search";
import { DispatchTable } from "./-components/DispatchTable";
import { NodeDrawer } from "./-components/drawer/NodeDrawer";
import { RunGraph } from "./-components/graph/RunGraph";
import { NodeList } from "./-components/NodeList";
import { RunDocs } from "./-components/RunDocs";
import { RunHeader } from "./-components/RunHeader";
import { Milestones, Models } from "./-components/RunSide";
import { Timeline, TimelineFilter } from "./-components/Timeline";
import { useIsDesktop } from "./-hooks/useIsDesktop";
import { type TranscriptFrame, useLiveRun } from "./-hooks/useLiveRun";
import { useTicker } from "./-hooks/useTicker";
import { applyPatch } from "./-lib/apply-patch";
import { type LiveLog, LiveLogContext } from "./-lib/live-log";
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
  search: { middlewares: [stripListDefaults] },
  component: RunPage,
});

// The detail's state (live entries) belongs to one run: another run remounts it.
function RunPage() {
  const { runId } = Route.useParams();
  return <RunDetail key={runId} runId={runId} />;
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
  // A live run's model is read once; the socket's patches keep it current.
  const model = useQuery({
    ...getRunModelOptions({ path: { id: runId } }),
    enabled: run.isSuccess,
    // A read started before a patch landed returns an older model, so keep the newer one held.
    structuralSharing: (old: unknown, next: unknown) =>
      old !== undefined && (next as RunModel).seq < (old as RunModel).seq ? old : replaceEqualDeep(old, next),
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
  const transcriptListeners = useRef(new Set<(f: TranscriptFrame) => void>());
  const modelKey = getRunModelQueryKey({ path: { id: runId } });
  // The socket opens once the model (and page 1, when shown) is in hand, and replays everything after the older of
  // the two: a replayed patch the model already holds changes nothing (the timeline list is newest first). A filtered
  // page's newest seq is older than the newest event, which only replays more; one model per poll keeps that cheap.
  const newest = page === 1 ? timeline.data?.items[0]?.seq : undefined;
  const { isConnected, watch } = useLiveRun(
    runId,
    live === true && model.isSuccess && (page !== 1 || timeline.isSuccess),
    (e) => {
      setLiveEntries((all) => (all.some((x) => x.seq === e.seq) ? all : [e, ...all].sort((a, b) => b.seq - a.seq)));
      // The header's facts (live roles, milestones, holds) are not in a patch: one read at a time keeps them fresh.
      void queryClient.invalidateQueries(
        { queryKey: getRunQueryKey({ path: { id: runId } }) },
        { cancelRefetch: false },
      );
    },
    Math.min(model.data?.seq ?? 0, newest ?? Number.MAX_SAFE_INTEGER),
    {
      onPatch: (p) => {
        // null: the server could not diff this event, so the model is read again
        if (p === null) void queryClient.invalidateQueries({ queryKey: modelKey });
        else queryClient.setQueryData<RunModel>(modelKey, (m) => (m ? applyPatch(m, p) : m));
      },
      onTranscript: (f) => transcriptListeners.current.forEach((fn) => fn(f)),
    },
  );
  // A reconnect may have missed patches the server can no longer diff against: read the model again, once.
  const everConnected = useRef(false);
  useEffect(() => {
    if (!isConnected) return;
    if (everConnected.current)
      void queryClient.invalidateQueries({ queryKey: getRunModelQueryKey({ path: { id: runId } }) });
    everConnected.current = true;
  }, [isConnected, queryClient, runId]);
  const liveLog = useMemo<LiveLog>(
    () => ({
      watch,
      subscribe: (fn) => {
        transcriptListeners.current.add(fn);
        return () => void transcriptListeners.current.delete(fn);
      },
    }),
    [watch],
  );
  const fetched = timeline.data?.items ?? [];
  const seen = new Set(fetched.map((e) => e.seq));
  const arrivedEntries = liveEntries.filter((e) => !seen.has(e.seq) && matchesTypes(types, e.type));
  const entries = page === 1 ? [...arrivedEntries, ...fetched] : fetched;
  const arrived = new Set(arrivedEntries.map((e) => e.seq));
  const tick = useTicker(live === true);
  const now = new Date(Math.max(run.dataUpdatedAt, timeline.dataUpdatedAt, model.dataUpdatedAt, tick));

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

  const steps = model.data?.nodes ?? [];
  const stepsAside = (
    <span className="flex items-center gap-4">
      {steps.length > 0 ? (
        <span className="text-muted font-mono text-xs tabular-nums">
          {steps.filter((n) => n.status === "done").length} done · {steps.filter((n) => n.status === "skipped").length}{" "}
          skipped · {steps.filter((n) => n.status === "failed").length} failed of {steps.length}
        </span>
      ) : null}
      {live ? (
        <output data-connected={isConnected} className="text-muted flex items-center gap-1.5 font-mono text-xs">
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", isConnected ? "bg-success motion-safe:animate-pulse" : "bg-muted")}
          />
          Live
        </output>
      ) : null}
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      <RunHeader run={r} model={model.data} live={live === true} now={now} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {is2 ? (
          <Tile title="Steps" aside={stepsAside} className="lg:col-span-12">
            {model.isPending ? (
              <div className="flex h-60 items-center justify-center">
                <Spinner size="sm" />
              </div>
            ) : model.isError ? (
              <div className="p-4">
                <LoadError title="Could not load the graph of this run" error={model.error} />
              </div>
            ) : isDesktop ? (
              <RunGraph
                model={model.data}
                milestones={r.milestones}
                selected={node}
                now={now.getTime()}
                onOpen={open}
              />
            ) : (
              <NodeList nodes={model.data.nodes} selected={node} now={now.getTime()} onOpen={open} />
            )}
          </Tile>
        ) : (
          <>
            <Alert status="warning" className="lg:col-span-12">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>
                  This run started on catherd 1.5. It has no graph; its dispatches, report and timeline are below.
                </Alert.Description>
              </Alert.Content>
            </Alert>
            <Tile title="Dispatches" className="lg:col-span-12">
              <DataList.State
                isLoading={model.isPending}
                error={model.error ?? undefined}
                isEmpty={(model.data?.dispatches.length ?? 0) === 0}
                emptyText="No dispatch was recorded."
              >
                <DispatchTable dispatches={model.data?.dispatches ?? []} />
              </DataList.State>
            </Tile>
          </>
        )}
        <RunDocs
          runId={runId}
          ended={r.phase === "ended" || !is2}
          planning={r.phase === "planning"}
          only={is2 ? undefined : "report.md"}
          className={is2 ? "lg:col-span-8" : "lg:col-span-12"}
        />
        {is2 ? (
          <div className="flex min-w-0 flex-col gap-4 lg:col-span-4">
            <Milestones milestones={r.milestones} />
            <Models dispatches={model.data?.dispatches ?? []} />
          </div>
        ) : null}
        <Tile
          title="Timeline"
          className="lg:col-span-12"
          aside={
            <TimelineFilter
              types={types}
              onChange={(t) => void navigate({ search: (prev) => ({ ...prev, page: 1, types: t }) })}
            />
          }
        >
          {timeline.isPending ? (
            <div className="flex justify-center py-10">
              <Spinner size="sm" />
            </div>
          ) : timeline.isError ? (
            <div className="p-4">
              <LoadError title="Could not load the timeline" error={timeline.error} />
            </div>
          ) : entries.length === 0 ? (
            <p className="text-muted px-4 py-4 text-sm">{types ? "No events of this type." : "No events yet."}</p>
          ) : (
            <Timeline entries={entries} now={now} arrived={arrived} />
          )}
          {(timeline.data?.total ?? 0) > 0 ? (
            <div className="border-border border-t px-4 py-2.5">
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
            </div>
          ) : null}
        </Tile>
      </div>
      {is2 && model.data ? (
        <LiveLogContext value={live ? liveLog : null}>
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
        </LiveLogContext>
      ) : null}
    </div>
  );
}
