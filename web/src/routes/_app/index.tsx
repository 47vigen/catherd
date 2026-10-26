import { Alert, Skeleton, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { getOverviewOptions } from "../../client/@tanstack/react-query.gen";
import { FanOut } from "../../components/brand/FanOut";
import { DataList } from "../../components/data-list/DataList";
import { PageHeader } from "../../components/page-header/PageHeader";
import { errorMessage } from "../../lib/api";
import { DailyChart } from "./-dashboard/DailyChart";
import { rangeOf, repoName } from "./-dashboard/format";
import { LiveStrip } from "./-dashboard/LiveStrip";
import { RecentRuns } from "./-dashboard/RecentRuns";
import { Recoveries } from "./-dashboard/Recoveries";
import { ModelShares, RoleShares } from "./-dashboard/Shares";
import { StatSheet } from "./-dashboard/StatSheet";
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

/** The bento's own shape while the first answer loads, so nothing jumps when it lands. */
function Loading() {
  return (
    <output aria-label="Loading" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <Skeleton className="h-28 rounded-sm lg:col-span-12" />
      <Skeleton className="h-36 rounded-sm lg:col-span-8" />
      <Skeleton className="h-36 rounded-sm lg:col-span-4" />
      <Skeleton className="h-80 rounded-sm lg:col-span-8" />
      <Skeleton className="h-80 rounded-sm lg:col-span-4" />
      <Skeleton className="h-56 rounded-sm lg:col-span-12" />
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
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description={`Live runs, open questions and the last ${days} days.`}
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
              <ToggleButton id="7" className="font-mono text-xs">
                7d
              </ToggleButton>
              <ToggleButton id="30" className="font-mono text-xs">
                <ToggleButtonGroup.Separator />
                30d
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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <StatSheet data={data} className="lg:col-span-12" />
          <LiveStrip live={data.live} className="lg:col-span-8" />
          <WaitingList questions={data.questions} now={new Date(now)} className="lg:col-span-4" />
          <DailyChart data={data} days={days} className="lg:col-span-8" />
          <ModelShares models={data.tokensByModel} className="lg:col-span-4" />
          <RoleShares roles={data.secsByRole} className="lg:col-span-8" />
          <Recoveries failovers={data.failovers} className="lg:col-span-4" />
          <RecentRuns runs={data.recent} now={new Date(now)} className="lg:col-span-12" />
        </div>
      )}
    </div>
  );
}
