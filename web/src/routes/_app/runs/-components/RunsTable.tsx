import { Link, Table } from "@heroui/react";

import type { RunCard } from "../../../../client";
import { StatusChip, type Status } from "../../../../components/status-chip/StatusChip";
import { formatRelative } from "../../../../lib/time";

/** What a run is doing: a 1.5 run is only informational, an outcome ends the story, a question comes next. */
const cardStatus = (r: RunCard): Status => {
  if (r.engine === "1.5") return "info";
  if (r.outcome) return r.outcome;
  if (r.openQuestions > 0) return "parked";
  return r.phase === "planning" || r.phase === "approval" ? r.phase : "running";
};

/** One page of runs; a row opens the run. */
export function RunsTable({ items, now, onOpen }: { items: RunCard[]; now: Date; onOpen(id: string): void }) {
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label="Runs" onRowAction={(key) => onOpen(String(key))}>
          <Table.Header>
            <Table.Column isRowHeader>Run</Table.Column>
            <Table.Column>Status</Table.Column>
            <Table.Column className="text-right">Milestones</Table.Column>
            <Table.Column className="text-right">Live</Table.Column>
            <Table.Column className="text-right">Questions</Table.Column>
            <Table.Column>Updated</Table.Column>
          </Table.Header>
          <Table.Body items={items}>
            {(r) => (
              <Table.Row id={r.id} className="cursor-pointer">
                <Table.Cell>
                  <div className="flex min-w-0 flex-col">
                    <Link href={`/runs/${encodeURIComponent(r.id)}`} className="text-[13px] no-underline">
                      {r.title}
                    </Link>
                    <span className="text-muted font-mono text-xs">{r.id}</span>
                  </div>
                </Table.Cell>
                <Table.Cell>
                  <StatusChip status={cardStatus(r)} />
                </Table.Cell>
                <Table.Cell className="text-right font-mono text-[13px] tabular-nums">
                  {r.milestones.landed}/{r.milestones.total}
                </Table.Cell>
                <Table.Cell className="text-right font-mono text-[13px] tabular-nums">{r.live.length}</Table.Cell>
                <Table.Cell className="text-right font-mono text-[13px] tabular-nums">{r.openQuestions}</Table.Cell>
                <Table.Cell className="text-muted text-[13px] whitespace-nowrap">
                  {formatRelative(r.endedAt ?? r.startedAt, now)}
                </Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
