import { Table } from "@heroui/react";

import type { Check } from "../../../../client";
import { StatusChip } from "../../../../components/status-chip/StatusChip";

/** Doctor's rows for the catalog and each backend: the state with its word, the detail, the fix to run. */
export function ChecksTable({ checks }: { checks: Check[] }) {
  return (
    <Table>
      <Table.ScrollContainer>
        <Table.Content aria-label="Catalog and backends">
          <Table.Header>
            <Table.Column isRowHeader>Name</Table.Column>
            <Table.Column>State</Table.Column>
            <Table.Column>Detail</Table.Column>
            <Table.Column>Fix</Table.Column>
          </Table.Header>
          <Table.Body items={checks}>
            {(c) => (
              <Table.Row id={c.id}>
                <Table.Cell className="text-[13px]">{c.label}</Table.Cell>
                <Table.Cell>
                  <StatusChip status={c.state} label={c.word} />
                </Table.Cell>
                <Table.Cell className="text-muted text-[13px]">{c.detail}</Table.Cell>
                <Table.Cell className="font-mono text-xs">{c.fix}</Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
