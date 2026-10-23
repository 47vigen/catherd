import { Table } from "@heroui/react";

import { formatCost, formatTokens, tokenTotal } from "../-lib/format";
import { formatDuration, parseRung } from "../-lib/node-view";
import type { Attempt } from "../../../../client";
import { ProviderIcon } from "../../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../../components/status-chip/StatusChip";

/** What a 1.5 run recorded: one row per dispatch, newest first. */
export function DispatchTable({ dispatches }: { dispatches: Attempt[] }) {
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label="Dispatches">
          <Table.Header>
            <Table.Column isRowHeader>Role</Table.Column>
            <Table.Column>Rung</Table.Column>
            <Table.Column>Status</Table.Column>
            <Table.Column className="text-right">Took</Table.Column>
            <Table.Column className="text-right">Tokens</Table.Column>
            <Table.Column className="text-right">Cost</Table.Column>
          </Table.Header>
          <Table.Body items={dispatches}>
            {(d) => (
              <Table.Row id={d.id}>
                <Table.Cell>
                  <div className="flex min-w-0 flex-col">
                    <span className="text-[13px]">{d.name ?? d.role ?? d.label}</span>
                    <span className="text-muted font-mono text-xs">{d.label}</span>
                  </div>
                </Table.Cell>
                <Table.Cell>
                  {d.rung ? (
                    <span className="flex items-center gap-1.5 font-mono text-xs">
                      <ProviderIcon backend={parseRung(d.rung).backend} size="xs" />
                      {d.rung}
                    </span>
                  ) : null}
                </Table.Cell>
                <Table.Cell>
                  <StatusChip status={d.status} />
                </Table.Cell>
                <Table.Cell className="text-right font-mono text-[13px] tabular-nums">
                  {d.secs == null ? "–" : formatDuration(d.secs)}
                </Table.Cell>
                <Table.Cell className="text-right font-mono text-[13px] tabular-nums">
                  {formatTokens(tokenTotal(d.tokens))}
                </Table.Cell>
                <Table.Cell className="text-right font-mono text-[13px] tabular-nums">
                  {formatCost(d.costUsd)}
                </Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
