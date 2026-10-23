import { Link, Table } from "@heroui/react";

import type { RunCard } from "../../../client";
import { backendName, ProviderIcon } from "../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../components/status-chip/StatusChip";
import { Tile } from "../../../components/tile/Tile";
import { formatRelative } from "../../../lib/time";
import { formatCost, formatCount, formatMinutes, repoName, runStatus } from "./format";

const NUM = "text-end font-mono text-[13px] tabular-nums";

/** The latest runs of the range across repos, one row each; a row opens the run. */
export function RecentRuns({ runs, now, className }: { runs: RunCard[]; now: Date; className?: string }) {
  return (
    <Tile
      title="Recent runs"
      className={className}
      aside={
        <Link href="/runs" className="text-xs">
          All runs
        </Link>
      }
    >
      {runs.length === 0 ? (
        <p className="text-muted px-4 py-3.5 text-sm">No run started in this range.</p>
      ) : (
        <Table
          variant="secondary"
          className="rounded-none [&_td]:px-3 [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th]:px-3 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4"
        >
          <Table.ScrollContainer>
            <Table.Content aria-label="Recent runs">
              <Table.Header>
                <Table.Column isRowHeader>Run</Table.Column>
                <Table.Column>Status</Table.Column>
                <Table.Column>Backends</Table.Column>
                <Table.Column className="text-end">Milestones</Table.Column>
                <Table.Column className="text-end">Time</Table.Column>
                <Table.Column className="text-end">Tokens</Table.Column>
                <Table.Column className="text-end">Cost</Table.Column>
                <Table.Column className="text-end">When</Table.Column>
              </Table.Header>
              <Table.Body items={runs}>
                {(run) => (
                  <Table.Row id={run.id} href={`/runs/${encodeURIComponent(run.id)}`} className="cursor-pointer">
                    <Table.Cell>
                      <span className="flex max-w-80 min-w-40 flex-col">
                        <Link
                          href={`/runs/${encodeURIComponent(run.id)}`}
                          className="text-foreground truncate text-[13px] font-medium no-underline"
                        >
                          {run.title}
                        </Link>
                        <span title={run.repo} className="text-muted truncate font-mono text-xs">
                          {repoName(run.repo)}
                        </span>
                      </span>
                    </Table.Cell>
                    <Table.Cell>
                      <StatusChip status={runStatus(run)} />
                    </Table.Cell>
                    <Table.Cell>
                      <span
                        className="flex items-center gap-1"
                        title={run.byBackend.map((b) => backendName(b.backend)).join(", ")}
                      >
                        {run.byBackend.map((b) => (
                          <ProviderIcon key={b.backend} backend={b.backend} size="xs" />
                        ))}
                      </span>
                    </Table.Cell>
                    <Table.Cell className={NUM}>
                      {run.milestones.landed}/{run.milestones.total}
                    </Table.Cell>
                    <Table.Cell className={NUM}>{formatMinutes(run.wallMinutes)}</Table.Cell>
                    <Table.Cell className={NUM}>
                      {formatCount(run.totals.tokens.input + run.totals.tokens.output)}
                    </Table.Cell>
                    <Table.Cell className={NUM}>{formatCost(run.totals.costUsd)}</Table.Cell>
                    <Table.Cell className="text-muted text-end text-[13px] whitespace-nowrap">
                      {formatRelative(run.endedAt ?? run.startedAt, now)}
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}
    </Tile>
  );
}
