import { CircleCheck } from "@gravity-ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { listAnsweredOptions, listQuestionsOptions } from "../../../client/@tanstack/react-query.gen";
import { DataList } from "../../../components/data-list/DataList";
import { PageHeader } from "../../../components/page-header/PageHeader";
import { Tile } from "../../../components/tile/Tile";
import { type ListSearch, parseListSearch, stripListDefaults } from "../../../lib/list-search";
import { formatRelative } from "../../../lib/time";
import { AnsweredList } from "./-components/AnsweredList";
import { QuestionDetail } from "./-components/QuestionDetail";
import { QuestionInbox } from "./-components/QuestionInbox";
import { keyOf, reasonLabel, waited } from "./-components/wait";

type QuestionsSearch = ListSearch & { run?: string; open?: string };

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

export const Route = createFileRoute("/_app/questions/")({
  validateSearch: (raw: Record<string, unknown>): QuestionsSearch => ({
    ...parseListSearch(raw),
    run: text(raw.run),
    open: text(raw.open),
  }),
  search: { middlewares: [stripListDefaults] },
  component: QuestionsPage,
});

function QuestionsPage() {
  const { page, pageSize, q, run, open } = Route.useSearch();
  const navigate = Route.useNavigate();
  const update = (next: Partial<QuestionsSearch>) =>
    void navigate({ search: (prev) => ({ ...prev, page: 1, ...next }), replace: true });
  const list = useQuery({
    ...listQuestionsOptions({ query: { run, q: q || undefined, limit: pageSize, offset: (page - 1) * pageSize } }),
    refetchInterval: 10_000,
  });
  const answered = useQuery({ ...listAnsweredOptions({ query: { run } }), refetchInterval: 10_000 });
  const items = list.data?.items ?? [];
  const done = answered.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const filtered = q !== "" || run !== undefined;
  const now = new Date(Math.max(list.dataUpdatedAt, answered.dataUpdatedAt) || Date.now());
  // The filter offers the runs of the questions on this page, by title.
  const runs = [...new Map(items.map((i) => [i.run, i.runTitle]))].map(([id, label]) => ({ id, label }));
  // An answered question leaves the list, and the next one takes its place: the inbox clears in one sitting.
  const current = items.find((i) => keyOf(i) === open) ?? items[0];
  const oldest = items.reduce<(typeof items)[number] | undefined>(
    (a, i) => (!a || Date.parse(i.at) < Date.parse(a.at) ? i : a),
    undefined,
  );
  const reasons = new Map<string, number>();
  for (const i of items) reasons.set(reasonLabel(i.reason), (reasons.get(reasonLabel(i.reason)) ?? 0) + 1);
  const common = [...reasons].sort((a, b) => b[1] - a[1])[0];
  const blockedRuns = new Set(items.map((i) => i.run)).size;
  const byJudge = done.filter((a) => a.by === "judge").length;

  return (
    <DataList.Root>
      <PageHeader
        title="Questions"
        description="A run stops here when it needs your decision. The rest of the run goes on."
      />
      <Tile.Stats className="md:grid-cols-4 xl:grid-cols-4">
        <Tile.Stat
          label="Waiting"
          value={total}
          hint={total ? `across ${blockedRuns} ${blockedRuns === 1 ? "run" : "runs"}` : "nothing to decide"}
        />
        <Tile.Stat
          label="Longest wait"
          value={
            oldest ? (
              <span className={waited(oldest.at, now).tone}>{formatRelative(oldest.at, now).replace(/ ago$/, "")}</span>
            ) : (
              "–"
            )
          }
          hint={oldest ? oldest.runTitle : undefined}
        />
        <Tile.Stat
          label="Answered"
          value={done.length}
          hint={done.length ? `last 24h · you ${done.length - byJudge} · judge ${byJudge}` : "last 24h"}
        />
        <Tile.Stat
          label="Most asked"
          value={<span className="text-[22px]">{common ? common[0] : "–"}</span>}
          hint={common ? `${common[1]} of ${items.length} on this page` : undefined}
        />
      </Tile.Stats>
      {total > 0 || filtered ? (
        <DataList.Toolbar>
          <DataList.Search value={q} onChange={(next) => update({ q: next })} placeholder="Search questions" />
          <DataList.Filters>
            <DataList.Filter label="Run" value={run} options={runs} onChange={(v) => update({ run: v })} />
          </DataList.Filters>
        </DataList.Toolbar>
      ) : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <DataList.State isLoading={list.isPending} error={list.error ?? undefined} isEmpty={false} emptyText="">
          {items.length === 0 ? (
            <Tile title="Waiting" className="lg:col-span-12">
              {filtered ? (
                <p className="text-muted px-4 py-3 text-[13px]">No question matches this search.</p>
              ) : (
                <p className="flex items-center gap-2.5 px-4 py-6 text-[13px]">
                  <CircleCheck aria-hidden="true" className="text-success size-4 shrink-0" />
                  Nothing is waiting for you.
                </p>
              )}
            </Tile>
          ) : (
            <>
              <Tile
                title="Waiting"
                aside={<span className="text-muted font-mono text-xs">↑ ↓</span>}
                className="lg:col-span-5"
              >
                <QuestionInbox
                  items={items}
                  selected={current ? keyOf(current) : undefined}
                  now={now}
                  onSelect={(key) => {
                    void navigate({ search: (prev) => ({ ...prev, open: key }), replace: true });
                    // stacked on a phone, the detail sits below the list: bring it into view
                    if (window.matchMedia("(max-width: 1023px)").matches)
                      requestAnimationFrame(() =>
                        document.querySelector('[aria-label="Question"]')?.scrollIntoView({ block: "center" }),
                      );
                  }}
                />
                {total > pageSize ? (
                  <div className="border-border mt-auto border-t px-4 py-2.5">
                    <DataList.Pagination
                      page={page}
                      pageSize={pageSize}
                      total={total}
                      onPageChange={(n) => void navigate({ search: (prev) => ({ ...prev, page: n }) })}
                      onPageSizeChange={(n) => update({ pageSize: n as ListSearch["pageSize"] })}
                    />
                  </div>
                ) : null}
              </Tile>
              {current ? <QuestionDetail key={keyOf(current)} q={current} now={now} className="lg:col-span-7" /> : null}
            </>
          )}
        </DataList.State>
        <AnsweredList items={done} isPending={answered.isPending} now={now} className="lg:col-span-12" />
      </div>
    </DataList.Root>
  );
}
