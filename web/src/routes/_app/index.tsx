import { Alert, Link, Skeleton, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { getOverviewOptions } from "../../client/@tanstack/react-query.gen";
import { FanOut } from "../../components/brand/FanOut";
import { DataList } from "../../components/data-list/DataList";
import { PageHeader, SectionLabel } from "../../components/page-header/PageHeader";
import { errorMessage } from "../../lib/api";
import { DashboardCharts } from "./-dashboard/DashboardCharts";
import { rangeOf, repoName } from "./-dashboard/format";
import { KpiRow } from "./-dashboard/KpiRow";
import { LiveStrip } from "./-dashboard/LiveStrip";
import { RecentRuns } from "./-dashboard/RecentRuns";
import { useNow } from "./-dashboard/useNow";
import { WaitingList } from "./-dashboard/WaitingList";

type DashboardSearch = { days?: 7 | 30; repo?: string };

export const Route = createFileRoute("/_app/")({
  validateSearch: (raw: Record<string, unknown>): DashboardSearch => ({
    days: Number(raw.days) === 30 ? 30 : undefined,
    repo: typeof raw.repo === "string" && raw.repo !== "" ? raw.repo : undefined,
  }),
  component: Dashboard,
});

const Section = ({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) => (
  <section className="flex min-w-0 flex-col gap-3">
    <SectionLabel aside={aside}>{title}</SectionLabel>
    {children}
  </section>
);

function Loading() {
  return (
    <output aria-label="Loading" className="flex flex-col gap-8">
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton className="h-44 rounded-sm" />
        <Skeleton className="h-44 rounded-sm" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-sm" />
        ))}
      </div>
      <Skeleton className="h-48 rounded-sm" />
    </output>
  );
}

/** Shown when catherd has never run anything: what it is and how to start. */
function Welcome() {
  return (
    <div className="border-border bg-surface grid items-center gap-6 rounded-sm border p-6 md:grid-cols-2 md:p-10">
      <div className="flex flex-col gap-3">
        <h2 className="text-xl font-medium tracking-[-0.02em]">No runs yet</h2>
        <p className="text-muted max-w-md text-sm leading-6">
          catherd runs a coding task for you: it plans it, has agents write and review the code, and checks the result.
        </p>
        <p className="text-sm leading-6">Start a run from Claude Code or Codex with /catherd.</p>
      </div>
      <FanOut className="max-h-64" />
    </div>
  );
}

function Dashboard() {
  const { days = 7, repo } = Route.useSearch();
  const navigate = Route.useNavigate();
  const set = (next: DashboardSearch) => void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const now = useNow(30_000);
  const range = rangeOf(days, new Date(now).toISOString().slice(0, 10));
  const overview = useQuery({
    ...getOverviewOptions({ query: { ...range, repo } }),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });
  const data = overview.data;
  const repos = (data?.repos ?? []).map((path) => ({ id: path, label: repoName(path) }));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Dashboard"
        description="What catherd is doing now, what waits for you, and how the last runs went."
        actions={
          <>
            {repos.length > 1 || repo ? (
              <DataList.Filter label="Repo" value={repo} options={repos} onChange={(v) => set({ repo: v })} />
            ) : null}
            <ToggleButtonGroup
              aria-label="Range"
              size="sm"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={new Set([String(days)])}
              onSelectionChange={(keys) => set({ days: keys.has("30") ? 30 : undefined })}
            >
              <ToggleButton id="7">7 days</ToggleButton>
              <ToggleButton id="30">
                <ToggleButtonGroup.Separator />
                30 days
              </ToggleButton>
            </ToggleButtonGroup>
          </>
        }
      />
      {overview.error && !data ? (
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Could not load the dashboard</Alert.Title>
            <Alert.Description>{errorMessage(overview.error)}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : !data ? (
        <Loading />
      ) : data.repos.length === 0 && data.live.length === 0 ? (
        <Welcome />
      ) : (
        <>
          <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Section
              title="Running now"
              aside={
                data.live.length > 0 ? (
                  <span className="text-muted flex items-center gap-2 font-mono text-xs">
                    <span aria-hidden="true" className="bg-success ring-running size-1.5 rounded-full" />
                    {data.live.length} live
                  </span>
                ) : undefined
              }
            >
              <LiveStrip live={data.live} />
            </Section>
            <Section
              title="Waiting for you"
              aside={
                <span className="flex items-center gap-3 text-xs">
                  {data.questions.total > 0 ? (
                    <span className="text-muted font-mono">{data.questions.total} waiting</span>
                  ) : null}
                  <Link href="/questions" className="text-xs">
                    All questions
                  </Link>
                </span>
              }
            >
              <WaitingList questions={data.questions} now={new Date(now)} />
            </Section>
          </div>
          <Section title={`The last ${days} days`}>
            <KpiRow kpis={data.kpis} />
            <DashboardCharts data={data} days={days} />
          </Section>
          <Section
            title="Recent runs"
            aside={
              <Link href="/runs" className="text-xs">
                All runs
              </Link>
            }
          >
            <RecentRuns runs={data.recent} now={new Date(now)} />
          </Section>
        </>
      )}
    </div>
  );
}
