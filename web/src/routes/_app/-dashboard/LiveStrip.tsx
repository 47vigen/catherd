import { Link, ProgressBar } from "@heroui/react";

import type { Overview } from "../../../client";
import { backendName, ProviderIcon } from "../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../components/status-chip/StatusChip";
import { Term } from "../../../components/term/Term";
import { formatCost, formatCount, formatElapsed, repoName, runStatus } from "./format";
import { useNow } from "./useNow";

function LiveCard({ item, now }: { item: Overview["live"][number]; now: number }) {
  const { run } = item;
  const { total, landed } = run.milestones;
  const tokens = run.totals.tokens.input + run.totals.tokens.output;
  return (
    <li className="border-border bg-surface hover:border-ink-faint relative flex min-w-0 flex-col gap-3 rounded-sm border p-4 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            href={`/runs/${encodeURIComponent(run.id)}`}
            className="block truncate text-sm font-medium no-underline after:absolute after:inset-0"
          >
            {run.title}
          </Link>
          <span title={run.repo} className="text-muted relative z-10 w-fit max-w-full truncate font-mono text-xs">
            {repoName(run.repo)}
          </span>
        </div>
        <StatusChip status={runStatus(run)} />
      </div>

      {total > 0 ? (
        <ProgressBar
          aria-label="Milestones landed"
          size="sm"
          color="success"
          value={landed}
          maxValue={total}
          valueLabel={`${landed}/${total}`}
        >
          <span className="text-muted text-xs">
            <span className="relative z-10">
              <Term name="milestone">Milestones</Term>
            </span>{" "}
            landed
          </span>
          <ProgressBar.Output className="font-mono text-xs" />
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
      ) : (
        <p className="text-muted text-xs">No plan yet.</p>
      )}

      <ul className="flex flex-col gap-2">
        {item.now.length === 0 ? (
          <li className="text-muted text-[13px]">
            {run.openQuestions > 0 ? "Waiting for your answer." : "Between steps."}
          </li>
        ) : (
          item.now.map((line) => (
            <li key={line.node} className="flex min-w-0 items-start gap-2.5">
              <ProviderIcon backend={line.rung ?? ""} size="md" className="mt-0.5" />
              <div
                key={line.text}
                className="flex min-w-0 flex-col transition-opacity duration-300 motion-reduce:transition-none starting:opacity-0"
              >
                <span className="truncate text-[13px] leading-5 font-medium">{line.title}</span>
                <span className="text-muted text-xs leading-4">
                  {line.text}
                  {line.rung ? ` · ${backendName(line.rung)}` : ""}
                </span>
              </div>
            </li>
          ))
        )}
      </ul>

      <div className="text-muted mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 font-mono text-xs tabular-nums">
        <span title="Time since the run started">{formatElapsed(now - Date.parse(run.startedAt))}</span>
        <span>{formatCost(run.totals.costUsd)}</span>
        <span>{formatCount(tokens)} tokens</span>
      </div>
    </li>
  );
}

/** Every run that has not ended, as a card; the clock and the `now` lines move while you watch. */
export function LiveStrip({ live }: { live: Overview["live"] }) {
  const now = useNow(1000, live.length > 0);
  if (live.length === 0)
    return (
      <p className="text-muted border-border rounded-sm border border-dashed px-4 py-6 text-sm">
        Nothing is running. Start a run from Claude Code or Codex with /catherd.
      </p>
    );
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {live.map((item) => (
        <LiveCard key={item.run.id} item={item} now={now} />
      ))}
    </ul>
  );
}
