import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { listQuestionsOptions } from "../../../client/@tanstack/react-query.gen";
import { DataList } from "../../../components/data-list/DataList";
import { PageHeader } from "../../../components/page-header/PageHeader";
import { type ListSearch, parseListSearch } from "../../../lib/list-search";
import { QuestionCard } from "./-components/QuestionCard";

type QuestionsSearch = ListSearch & { run?: string };

export const Route = createFileRoute("/_app/questions/")({
  validateSearch: (raw: Record<string, unknown>): QuestionsSearch => ({
    ...parseListSearch(raw),
    run: typeof raw.run === "string" && raw.run !== "" ? raw.run : undefined,
  }),
  component: QuestionsPage,
});

function QuestionsPage() {
  const { page, pageSize, q, run } = Route.useSearch();
  const navigate = Route.useNavigate();
  const update = (next: Partial<QuestionsSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, page: 1, ...next }), replace: true });
  const list = useQuery({
    ...listQuestionsOptions({ query: { run, q: q || undefined, limit: pageSize, offset: (page - 1) * pageSize } }),
    refetchInterval: 10_000,
  });
  const items = list.data?.items ?? [];
  // The filter offers the runs of the questions on this page, by title.
  const runs = [...new Map(items.map((i) => [i.run, i.runTitle]))].map(([id, label]) => ({ id, label }));

  return (
    <DataList.Root>
      <PageHeader
        title="Questions"
        description="Units of a run that wait for your answer. The rest of the run goes on while they wait."
      />
      <DataList.Toolbar>
        <DataList.Search value={q} onChange={(next) => update({ q: next })} placeholder="Search questions" />
        <DataList.Filters>
          <DataList.Filter label="Run" value={run} options={runs} onChange={(v) => update({ run: v })} />
        </DataList.Filters>
      </DataList.Toolbar>
      <DataList.State
        isLoading={list.isPending}
        error={list.error ?? undefined}
        isEmpty={items.length === 0}
        emptyText="Nothing is waiting for you."
      >
        <div className="flex flex-col gap-3">
          {items.map((p) => (
            <QuestionCard key={`${p.run}/${p.unit}`} q={p} now={new Date(list.dataUpdatedAt)} />
          ))}
        </div>
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
