import { Link, ProgressBar } from "@heroui/react";

import type { Overview } from "../../../client";
import { backendName, ProviderIcon } from "../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../components/status-chip/StatusChip";
import { Term } from "../../../components/term/Term";
import { Tile } from "../../../components/tile/Tile";
import { formatCost, formatCount, formatElapsed, repoName, runStatus } from "./format";
import { useNow } from "./useNow";

function LiveCard({ item, now }: { item: Overview["live"][number]; now: number }) {
  const { run } = item;
  const { total, landed } = run.milestones;
  const tokens = run.totals.tokens.input + run.totals.tokens.output;
  return (
    <li className="bg-surface hover:bg-surface-secondary relative flex min-w-0 flex-col gap-4 p-4 transition-colors duration-150">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Link
            href={`/runs/${encodeURIComponent(run.id)}`}
            className="text-foreground block truncate text-sm font-medium no-underline after:absolute after:inset-0"
          >
            {run.title}
          </Link>
          <span title={run.repo} className="text-muted relative z-10 w-fit max-w-full truncate font-mono text-xs">
            {repoName(run.repo)}
          </span>
        </div>
        <StatusChip status={runStatus(run)} />
      </div>

      <ul className="flex flex-col gap-2.5">
        {item.now.length === 0 ? (
          <li className="text-muted text-[13px]">
            {run.openQuestions > 0 ? "Waiting for your answer." : "Between steps."}
          </li>
        ) : (
          item.now.map((line) => (
            <li key={line.node} className="flex min-w-0 items-start gap-2.5">
              <ProviderIcon backend={line.rung ?? ""} size="sm" className="mt-px" />
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

      <div className="mt-auto flex flex-col gap-3">
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
          <p className="text-muted text-xs">Planning the milestones.</p>
        )}
        <div className="text-muted flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs tabular-nums">
          <span title="Time since the run started" className="text-foreground">
            {formatElapsed(now - Date.parse(run.startedAt))}
          </span>
          <span>{formatCost(run.totals.costUsd)}</span>
          {run.totals.unpriced > 0 ? <span>{run.totals.unpriced} unpriced</span> : null}
          <span>{formatCount(tokens)} tokens</span>
        </div>
      </div>
    </li>
  );
}

/** Every run that has not ended, as a cell of one sheet; the clock and the `now` lines move while you watch. */
export function LiveStrip({ live, className }: { live: Overview["live"]; className?: string }) {
  const now = useNow(1000, live.length > 0);
  return (
    <Tile
      title="Running now"
      className={className}
      aside={
        live.length > 0 ? (
          <span className="text-muted flex items-center gap-2 font-mono text-xs">
            <span aria-hidden="true" className="bg-success ring-running size-1.5 rounded-full" />
            {live.length} live
          </span>
        ) : undefined
      }
    >
      {live.length === 0 ? (
        <p className="text-muted flex items-center gap-2.5 px-4 py-3.5 text-sm">
          <span aria-hidden="true" className="bg-muted/50 size-1.5 rounded-full" />
          Nothing is running. Start a run from Claude Code or Codex with /catherd.
        </p>
      ) : (
        <ul className="bg-border grid flex-1 gap-px md:grid-cols-2 md:[&>:last-child:nth-child(odd)]:col-span-2">
          {live.map((item) => (
            <LiveCard key={item.run.id} item={item} now={now} />
          ))}
        </ul>
      )}
    </Tile>
  );
}
