import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { listRunsOptions } from "../../../client/@tanstack/react-query.gen";
import { DataList } from "../../../components/data-list/DataList";
import { PageHeader } from "../../../components/page-header/PageHeader";
import { type ListSearch, parseEnum, parseListSearch } from "../../../lib/list-search";
import { RunsTable } from "./-components/RunsTable";

const PHASES = [
  { id: "planning", label: "Planning" },
  { id: "approval", label: "Approval" },
  { id: "running", label: "Running" },
  { id: "ended", label: "Ended" },
] as const;
type RunsSearch = ListSearch & { phase?: (typeof PHASES)[number]["id"] };

export const Route = createFileRoute("/_app/runs/")({
  validateSearch: (raw: Record<string, unknown>): RunsSearch => ({
    ...parseListSearch(raw),
    phase: parseEnum(
      raw.phase,
      PHASES.map((p) => p.id),
    ),
  }),
  component: RunsPage,
});

function RunsPage() {
  const { page, pageSize, q, phase } = Route.useSearch();
  const navigate = Route.useNavigate();
  const update = (next: Partial<RunsSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, page: 1, ...next }), replace: true });
  const list = useQuery({
    ...listRunsOptions({ query: { q: q || undefined, phase, limit: pageSize, offset: (page - 1) * pageSize } }),
    refetchInterval: 10_000,
  });

  return (
    <DataList.Root>
      <PageHeader
        title="Runs"
        description="Every run catherd drove, newest first. A run starts from your Claude Code or Codex session."
      />
      <DataList.Toolbar>
        <DataList.Search value={q} onChange={(next) => update({ q: next })} placeholder="Search runs" />
        <DataList.Filters>
          <DataList.Filter label="Phase" value={phase} options={PHASES} onChange={(v) => update({ phase: v })} />
        </DataList.Filters>
      </DataList.Toolbar>
      <DataList.State
        isLoading={list.isPending}
        error={list.error ?? undefined}
        isEmpty={(list.data?.items.length ?? 0) === 0}
        emptyText="No runs yet. Start one from your session with run_start."
      >
        <RunsTable
          items={list.data?.items ?? []}
          now={new Date(list.dataUpdatedAt)}
          onOpen={(id) =>
            void navigate({ to: "/runs/$runId", params: { runId: id }, search: { page: 1, pageSize: 25, q: "" } })
          }
        />
      </DataList.State>
      <DataList.Pagination
        page={page}
        pageSize={pageSize}
        total={list.data?.total ?? 0}
        onPageChange={(n) => void navigate({ search: (prev) => ({ ...prev, page: n }) })}
        onPageSizeChange={(n) => update({ pageSize: n as ListSearch["pageSize"] })}
      />
    </DataList.Root>
  );
}
