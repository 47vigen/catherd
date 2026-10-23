import { Link } from "@heroui/react";

import type { RunCard } from "../../../client";
import { ProviderIcon } from "../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../components/status-chip/StatusChip";
import { formatRelative } from "../../../lib/time";
import { formatCost, formatCount, formatMinutes, repoName, runStatus } from "./format";

function Row({ run, now }: { run: RunCard; now: Date }) {
  const tokens = run.totals.tokens.input + run.totals.tokens.output;
  return (
    <li className="hover:bg-surface-secondary relative flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <Link
          href={`/runs/${encodeURIComponent(run.id)}`}
          className="block truncate text-[13px] font-medium no-underline after:absolute after:inset-0"
        >
          {run.title}
        </Link>
        <span title={run.repo} className="text-muted truncate font-mono text-xs">
          {repoName(run.repo)}
        </span>
      </div>
      <StatusChip status={runStatus(run)} />
      <span className="flex items-center gap-1">
        {run.byBackend.map((b) => (
          <ProviderIcon key={b.backend} backend={b.backend} size="xs" />
        ))}
      </span>
      <div className="text-muted flex items-center gap-4 font-mono text-xs tabular-nums max-sm:w-full">
        <span title="Milestones landed" className="w-12">
          {run.milestones.landed}/{run.milestones.total}
        </span>
        <span title="Wall time" className="w-14">
          {formatMinutes(run.wallMinutes)}
        </span>
        <span title="Cost" className="w-14">
          {formatCost(run.totals.costUsd)}
        </span>
        <span title="Tokens" className="w-14">
          {formatCount(tokens)}
        </span>
        <span className="font-sans whitespace-nowrap">{formatRelative(run.endedAt ?? run.startedAt, now)}</span>
      </div>
    </li>
  );
}

/** The latest runs of the range across repos, one line each; a row opens the run. */
export function RecentRuns({ runs, now }: { runs: RunCard[]; now: Date }) {
  if (runs.length === 0)
    return (
      <p className="text-muted border-border rounded-sm border border-dashed px-4 py-6 text-sm">
        No run started in this range.
      </p>
    );
  return (
    <ul className="border-border bg-surface divide-border divide-y overflow-hidden rounded-sm border">
      {runs.map((run) => (
        <Row key={run.id} run={run} now={now} />
      ))}
    </ul>
  );
}
