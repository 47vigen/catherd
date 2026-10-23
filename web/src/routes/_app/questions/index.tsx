import { CircleCheck } from "@gravity-ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { listQuestionsOptions } from "../../../client/@tanstack/react-query.gen";
import { DataList } from "../../../components/data-list/DataList";
import { PageHeader } from "../../../components/page-header/PageHeader";
import { Tile } from "../../../components/tile/Tile";
import { type ListSearch, parseListSearch, stripListDefaults } from "../../../lib/list-search";
import { AnsweredList } from "./-components/AnsweredList";
import { QuestionCard } from "./-components/QuestionCard";

type QuestionsSearch = ListSearch & { run?: string };

export const Route = createFileRoute("/_app/questions/")({
  validateSearch: (raw: Record<string, unknown>): QuestionsSearch => ({
    ...parseListSearch(raw),
    run: typeof raw.run === "string" && raw.run !== "" ? raw.run : undefined,
  }),
  search: { middlewares: [stripListDefaults] },
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
  const total = list.data?.total ?? 0;
  const filtered = q !== "" || run !== undefined;
  // The filter offers the runs of the questions on this page, by title.
  const runs = [...new Map(items.map((i) => [i.run, i.runTitle]))].map(([id, label]) => ({ id, label }));

  return (
    <DataList.Root>
      <PageHeader
        title="Questions"
        description="A run stops here when it needs your decision. The rest of the run goes on."
      />
      {total > 0 || filtered ? (
        <DataList.Toolbar>
          <DataList.Search value={q} onChange={(next) => update({ q: next })} placeholder="Search questions" />
          <DataList.Filters>
            <DataList.Filter label="Run" value={run} options={runs} onChange={(v) => update({ run: v })} />
          </DataList.Filters>
        </DataList.Toolbar>
      ) : null}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-8">
          <DataList.State isLoading={list.isPending} error={list.error ?? undefined} isEmpty={false} emptyText="">
            {items.length === 0 ? (
              <Tile title="Waiting">
                {filtered ? (
                  <p className="text-muted px-4 py-3 text-[13px]">No question matches this search.</p>
                ) : (
                  <p className="flex items-center gap-2.5 px-4 py-3 text-[13px]">
                    <CircleCheck aria-hidden="true" className="text-success size-4 shrink-0" />
                    Nothing is waiting for you.
                  </p>
                )}
              </Tile>
            ) : (
              items.map((p) => <QuestionCard key={`${p.run}/${p.unit}`} q={p} now={new Date(list.dataUpdatedAt)} />)
            )}
          </DataList.State>
          <DataList.Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={(n) => void navigate({ search: (prev) => ({ ...prev, page: n }) })}
            onPageSizeChange={(n) => update({ pageSize: n as ListSearch["pageSize"] })}
          />
        </div>
        <AnsweredList run={run} className="lg:col-span-4" />
      </div>
    </DataList.Root>
  );
}
