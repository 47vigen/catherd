import { ArrowLeft } from "@gravity-ui/icons";
import { Alert, Button, Link, Spinner, toast } from "@heroui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import type { RunView, TimelineEntry } from "../../../client";
import { cancelRunMutation, getRunOptions, getRunTimelineOptions } from "../../../client/@tanstack/react-query.gen";
import { ConfirmDelete } from "../../../components/confirm-delete/ConfirmDelete";
import { DataList } from "../../../components/data-list/DataList";
import { PageHeader, SectionLabel } from "../../../components/page-header/PageHeader";
import { StatusChip } from "../../../components/status-chip/StatusChip";
import { errorMessage } from "../../../lib/api";
import { type ListSearch, parseListSearch } from "../../../lib/list-search";
import { invalidateOps } from "../../../lib/query";
import { formatRelative } from "../../../lib/time";
import { Timeline } from "./-components/Timeline";
import { useLiveRun } from "./-hooks/useLiveRun";
import { runStatus } from "./-lib/run-status";

export const Route = createFileRoute("/_app/runs/$runId")({
  validateSearch: parseListSearch,
  component: RunPage,
});

// The detail's state (live entries) belongs to one run: another run remounts it.
function RunPage() {
  const { runId } = Route.useParams();
  return <RunDetail key={runId} runId={runId} />;
}

const milestoneStatus = (s: string) =>
  s === "landed" || s === "merged" ? "done" : s === "parked" ? "parked" : "running";

function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel aside={aside}>{title}</SectionLabel>
      {children}
    </section>
  );
}

const Rows = ({ children, label }: { children: ReactNode; label: string }) => (
  <ul aria-label={label} className="border-border bg-surface divide-border divide-y rounded-sm border">
    {children}
  </ul>
);
const rowClass = "flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[13px]";

function Facts({ run, now }: { run: RunView; now: Date }) {
  return (
    <>
      <Block title="Milestones">
        {run.milestones.length === 0 ? (
          <p className="text-muted text-sm">No plan yet.</p>
        ) : (
          <Rows label="Milestones">
            {run.milestones.map((m) => (
              <li key={m.id} className={rowClass}>
                <span className="w-10 font-mono text-xs">{m.id}</span>
                <span className="min-w-0 flex-1">{m.title}</span>
                <StatusChip status={milestoneStatus(m.status)} />
                <span className="text-muted font-mono text-xs">round {m.round}</span>
                <span className="text-muted w-16 font-mono text-xs">{m.commit?.slice(0, 7) ?? ""}</span>
              </li>
            ))}
          </Rows>
        )}
      </Block>
      <Block title="Live roles">
        {run.live.length === 0 ? (
          <p className="text-muted text-sm">No role is running.</p>
        ) : (
          <Rows label="Live roles">
            {run.live.map((d) => (
              <li key={d.name} className={rowClass}>
                <span className="font-mono text-xs">{d.name}</span>
                <span className="text-muted">{d.role}</span>
                <span className="font-mono text-xs">{d.rung}</span>
                <span className="text-muted ml-auto">since {formatRelative(d.since, now)}</span>
              </li>
            ))}
          </Rows>
        )}
      </Block>
      <Block title="Questions">
        {run.parked.length === 0 ? (
          <p className="text-muted text-sm">Nothing is waiting for you.</p>
        ) : (
          <Rows label="Questions">
            {run.parked.map((p) => (
              <li key={p.unit} className={rowClass}>
                <span className="font-mono text-xs">{p.unit}</span>
                <span className="min-w-0 flex-1 break-words">{p.question}</span>
                <Link href={`/questions?run=${encodeURIComponent(run.id)}`} className="text-sm">
                  Answer
                </Link>
              </li>
            ))}
          </Rows>
        )}
      </Block>
      {run.holds.length > 0 ? (
        <Block title="Quota holds">
          <Rows label="Quota holds">
            {run.holds.map((h) => (
              <li key={h.quota} className={rowClass}>
                <span className="font-mono text-xs">{h.quota}</span>
                <StatusChip status="held" until={h.until} />
              </li>
            ))}
          </Rows>
        </Block>
      ) : null}
    </>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const { page, pageSize } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = Route.useRouteContext({ select: (c) => c.queryClient });
  const run = useQuery({ ...getRunOptions({ path: { id: runId } }), refetchInterval: 10_000 });
  const is2 = run.data?.engine === "2.0";
  const live = is2 && run.data?.phase !== "ended";
  const timeline = useQuery({
    ...getRunTimelineOptions({ path: { id: runId }, query: { limit: pageSize, offset: (page - 1) * pageSize } }),
    enabled: is2,
  });

  // Live entries sit before the fetched ones on page 1; a frame the page already holds is dropped by its seq.
  const [liveEntries, setLiveEntries] = useState<TimelineEntry[]>([]);
  const { isConnected } = useLiveRun(runId, live, (e) => {
    setLiveEntries((all) => (all.some((x) => x.seq === e.seq) ? all : [e, ...all].sort((a, b) => b.seq - a.seq)));
    void invalidateOps(queryClient, "getRun");
  });
  const fetched = timeline.data?.items ?? [];
  const seen = new Set(fetched.map((e) => e.seq));
  const entries = page === 1 ? [...liveEntries.filter((e) => !seen.has(e.seq)), ...fetched] : fetched;
  const now = new Date(Math.max(run.dataUpdatedAt, timeline.dataUpdatedAt));

  const [confirming, setConfirming] = useState(false);
  const cancel = useMutation({
    ...cancelRunMutation(),
    onSuccess: async () => {
      setConfirming(false);
      toast.success("Cancelling. Live roles are being stopped.");
      await invalidateOps(queryClient, "getRun", "listRuns");
    },
    onError: (e) => toast.danger(errorMessage(e)),
  });

  if (run.isPending)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  if (run.isError)
    return (
      <Alert status="danger" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Could not load this run</Alert.Title>
          <Alert.Description>{errorMessage(run.error)}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  const r = run.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        before={
          <Link href="/runs" className="text-muted hover:text-foreground w-fit gap-1.5 text-sm no-underline">
            <ArrowLeft aria-hidden="true" className="size-4" />
            Runs
          </Link>
        }
        title={r.title}
        description={`${r.id} · ${r.repo}`}
        actions={
          <>
            <StatusChip status={runStatus(r)} />
            {live ? (
              <Button size="sm" variant="secondary" onPress={() => setConfirming(true)}>
                Cancel run
              </Button>
            ) : null}
          </>
        }
      />
      {is2 ? (
        <>
          <Facts run={r} now={now} />
          <Block
            title="Timeline"
            aside={
              live ? (
                <output className="text-muted flex items-center gap-1.5 font-mono text-xs">
                  <span
                    aria-hidden="true"
                    className={
                      isConnected
                        ? "bg-accent size-1.5 rounded-full motion-safe:animate-pulse"
                        : "bg-muted size-1.5 rounded-full"
                    }
                  />
                  Live
                </output>
              ) : null
            }
          >
            <DataList.State
              isLoading={timeline.isPending}
              error={timeline.error ?? undefined}
              isEmpty={entries.length === 0}
              emptyText="No events yet."
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
        </>
      ) : (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {`This run started on catherd 1.5. Its timeline is not recorded; catherd status ${r.id} shows it.`}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <ConfirmDelete
        title={`Cancel ${r.title}?`}
        body="Every live role is stopped and the run ends. It cannot be resumed."
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        isOpen={confirming}
        isPending={cancel.isPending}
        onConfirm={() => cancel.mutate({ path: { id: runId } })}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
