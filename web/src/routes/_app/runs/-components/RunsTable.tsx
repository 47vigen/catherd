import { cn, Link, Table, Tooltip } from "@heroui/react";

import { formatCost, formatTokens } from "../-lib/format";
import { formatElapsed, repoName, runStatus } from "../../-dashboard/format";
import type { RunCard } from "../../../../client";
import { backendName, ProviderIcon } from "../../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../../components/status-chip/StatusChip";
import { formatRelative } from "../../../../lib/time";

const NUM = "text-right font-mono text-[13px] tabular-nums whitespace-nowrap";
const DASH = <span className="text-muted">–</span>;

/** The marks of the backends a run used, most tokens first; the models and their tokens are in the tooltip. */
function Models({ run }: { run: RunCard }) {
  if (run.byBackend.length === 0) return DASH;
  const backends = run.byBackend.toSorted((a, b) => b.tokens - a.tokens);
  return (
    <Tooltip delay={200}>
      <Tooltip.Trigger
        aria-label={`Models: ${run.byModel.map((m) => m.model.split(":").pop()).join(", ")}`}
        className="flex w-fit items-center gap-1"
      >
        {backends.map((b) => (
          <ProviderIcon key={b.backend} backend={b.backend} size="xs" />
        ))}
      </Tooltip.Trigger>
      <Tooltip.Content className="flex flex-col gap-1 py-1.5">
        {run.byModel
          .toSorted((a, b) => b.tokens - a.tokens)
          .map((m) => (
            <span key={m.model} className="flex items-center gap-2 text-xs">
              <ProviderIcon backend={m.model} size="xs" />
              <span className="font-mono">{m.model.split(":").pop()}</span>
              <span className="text-muted ml-auto pl-3 font-mono tabular-nums">{formatTokens(m.tokens)}</span>
            </span>
          ))}
        <span className="text-muted text-[11px]">{backends.map((b) => backendName(b.backend)).join(" · ")}</span>
      </Tooltip.Content>
    </Tooltip>
  );
}

/** One page of runs; a row opens the run. */
export function RunsTable({ items, now, onOpen }: { items: RunCard[]; now: Date; onOpen(id: string): void }) {
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label="Runs" onRowAction={(key) => onOpen(String(key))}>
          <Table.Header>
            <Table.Column isRowHeader>Run</Table.Column>
            <Table.Column>Status</Table.Column>
            <Table.Column>Models</Table.Column>
            <Table.Column className="text-right">Milestones</Table.Column>
            <Table.Column className="text-right">Wall</Table.Column>
            <Table.Column className="text-right">Tokens</Table.Column>
            <Table.Column className="text-right">Cost</Table.Column>
            <Table.Column className="text-right">Updated</Table.Column>
          </Table.Header>
          <Table.Body items={items}>
            {(r) => {
              const tokens = r.totals.tokens.input + r.totals.tokens.output;
              // a run still going has no wall time yet: it reads as the time since it started
              const wallMs =
                r.wallMinutes !== null
                  ? r.wallMinutes * 60_000
                  : r.endedAt
                    ? null
                    : now.getTime() - Date.parse(r.startedAt);
              return (
                <Table.Row id={r.id} className="cursor-pointer">
                  <Table.Cell>
                    <div className="flex max-w-96 min-w-40 flex-col gap-0.5">
                      <Link
                        href={`/runs/${encodeURIComponent(r.id)}`}
                        className="text-foreground truncate text-[13px] font-medium no-underline hover:underline"
                      >
                        {r.title}
                      </Link>
                      <span title={`${r.repo} · ${r.id}`} className="text-muted truncate font-mono text-xs">
                        {repoName(r.repo)}
                      </span>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <StatusChip
                      status={runStatus(r)}
                      label={
                        r.openQuestions > 0 && !r.outcome && !r.paused
                          ? `${r.openQuestions} ${r.openQuestions === 1 ? "question" : "questions"}`
                          : undefined
                      }
                    />
                  </Table.Cell>
                  <Table.Cell>
                    <Models run={r} />
                  </Table.Cell>
                  <Table.Cell className={NUM}>
                    {r.milestones.total === 0 ? (
                      DASH
                    ) : (
                      <span className={cn(r.milestones.landed < r.milestones.total && "text-muted")}>
                        {r.milestones.landed}/{r.milestones.total}
                      </span>
                    )}
                  </Table.Cell>
                  <Table.Cell className={NUM}>{wallMs === null ? DASH : formatElapsed(wallMs)}</Table.Cell>
                  <Table.Cell className={NUM}>{tokens > 0 ? formatTokens(tokens) : DASH}</Table.Cell>
                  <Table.Cell className={NUM}>
                    {formatCost(r.totals.costUsd)}
                    {r.totals.unpriced > 0 ? (
                      <span className="text-muted block text-xs">{r.totals.unpriced} unpriced</span>
                    ) : null}
                  </Table.Cell>
                  <Table.Cell className="text-muted text-right text-[13px] whitespace-nowrap">
                    <time
                      dateTime={r.endedAt ?? r.startedAt}
                      title={new Date(r.endedAt ?? r.startedAt).toLocaleString()}
                    >
                      {formatRelative(r.endedAt ?? r.startedAt, now)}
                    </time>
                  </Table.Cell>
                </Table.Row>
              );
            }}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
