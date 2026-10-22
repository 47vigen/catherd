import { Button } from "@heroui/react";

import type { SetupView } from "../../../../client";
import { StatusChip } from "../../../../components/status-chip/StatusChip";

/** One role: whether it is on, and its rungs from the cheapest up, each with its indexed intelligence. */
export function RoleLadder({ role, onEdit }: { role: SetupView["roles"][number]; onEdit(): void }) {
  return (
    <fieldset
      aria-label={role.role}
      className="border-border bg-surface flex min-w-0 flex-col gap-2 rounded-sm border p-3"
    >
      <div className="flex items-center gap-3">
        <span className="font-mono text-[13px] font-medium">{role.role}</span>
        <StatusChip status={role.enabled ? "ok" : "skip"} label={role.enabled ? "enabled" : "off"} />
        <Button size="sm" variant="secondary" className="ml-auto" onPress={onEdit} isDisabled={role.hostSet}>
          Edit rungs
        </Button>
      </div>
      {role.hostSet ? (
        <>
          <p className="text-muted text-sm">Set by the session&apos;s host.</p>
          <p className="text-muted text-xs">
            To edit it, start the panel with --host codex|claude-code, or run catherd init.
          </p>
        </>
      ) : role.rungs.length === 0 ? (
        <p className="text-muted text-sm">No rungs.</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {role.rungs.map((r) => (
            <li key={r.rung} className="flex items-baseline gap-3 text-[13px]">
              <span className="font-mono text-xs">{r.rung}</span>
              <span className="text-muted font-mono text-xs tabular-nums">
                {r.intelligence === null ? "–" : r.intelligence.toFixed(1)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </fieldset>
  );
}
