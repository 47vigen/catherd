import { Link, Table } from "@heroui/react";

import { daemonStatus, runStatus } from "../-lib/run-status";
import type { RunView } from "../../../../client";
import { StatusChip } from "../../../../components/status-chip/StatusChip";
import { formatRelative } from "../../../../lib/time";

const landed = (r: RunView) => r.milestones.filter((m) => m.status === "landed" || m.status === "merged").length;

/** One page of runs; a row opens the run. A 1.5 run has no daemon or milestones of its own to show. */
export function RunsTable({ items, now, onOpen }: { items: RunView[]; now: Date; onOpen(id: string): void }) {
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
            <Table.Column>Daemon</Table.Column>
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
                  <StatusChip status={runStatus(r)} />
                </Table.Cell>
                <Table.Cell className="text-right font-mono text-[13px] tabular-nums">
                  {landed(r)}/{r.milestones.length}
                </Table.Cell>
                <Table.Cell className="text-right font-mono text-[13px] tabular-nums">{r.live.length}</Table.Cell>
                <Table.Cell className="text-right font-mono text-[13px] tabular-nums">{r.parked.length}</Table.Cell>
                <Table.Cell>
                  {r.engine === "1.5" || r.phase === "ended" ? (
                    <span className="text-muted">–</span>
                  ) : (
                    <StatusChip status={daemonStatus(r)} />
                  )}
                </Table.Cell>
                <Table.Cell className="text-muted text-[13px] whitespace-nowrap">
                  {formatRelative(r.updatedAt, now)}
                </Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
