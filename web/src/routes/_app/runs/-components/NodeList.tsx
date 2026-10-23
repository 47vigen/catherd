import { parseRung } from "../-lib/node-view";
import type { RunNode } from "../../../../client";
import { ProviderIcon } from "../../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../../components/status-chip/StatusChip";

/** The steps of a run as a list, for phones, where the graph is left out. */
export function NodeList({
  nodes,
  selected,
  onOpen,
}: {
  nodes: RunNode[];
  selected: string | undefined;
  onOpen: (id: string) => void;
}) {
  return (
    <ol aria-label="Steps" className="border-border bg-surface divide-border divide-y rounded-sm border">
      {nodes.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            aria-current={n.id === selected ? "true" : undefined}
            onClick={() => onOpen(n.id)}
            className="hover:bg-surface-secondary focus-visible:outline-focus aria-[current=true]:bg-surface-secondary flex w-full flex-col gap-1 px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{n.title}</span>
              {n.rung && n.kind !== "check" ? <ProviderIcon backend={parseRung(n.rung).backend} size="xs" /> : null}
              <StatusChip status={n.status} />
            </span>
            <span className="text-muted text-xs">{n.now}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
