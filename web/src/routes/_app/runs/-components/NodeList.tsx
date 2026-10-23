import { cn } from "@heroui/react";

import {
  formatDuration,
  modelName,
  nodeSecs,
  nowLine,
  parseRung,
  shortTitle,
  STATUS_LABEL,
  STATUS_TONE,
} from "../-lib/node-view";
import type { RunNode } from "../../../../client";
import { ProviderIcon } from "../../../../components/provider-icon/ProviderIcon";
import { StatusGlyph } from "./graph/NodeCard";

const WORD = {
  running: "text-success",
  success: "text-muted",
  danger: "text-danger",
  warning: "text-warning",
  muted: "text-muted",
} as const;

/** The steps of a run as a list, for phones, where the graph is left out; a milestone heads its steps. */
export function NodeList({
  nodes,
  selected,
  now,
  onOpen,
}: {
  nodes: RunNode[];
  selected: string | undefined;
  now: number;
  onOpen: (id: string) => void;
}) {
  return (
    <ol aria-label="Steps" className="divide-separator divide-y">
      {nodes.map((n, i) => {
        const rung = n.rung && n.kind !== "check" ? parseRung(n.rung) : null;
        const secs = nodeSecs(n, now);
        const opens = n.milestone !== null && nodes[i - 1]?.milestone !== n.milestone;
        return (
          <li key={n.id}>
            {opens ? (
              <span className="label-caps text-muted bg-surface-secondary block px-4 py-1.5">{n.milestone}</span>
            ) : null}
            <button
              type="button"
              aria-label={[n.title, STATUS_LABEL[n.status], nowLine(n)].filter(Boolean).join(". ")}
              aria-current={n.id === selected ? "true" : undefined}
              onClick={() => onOpen(n.id)}
              className={cn(
                "hover:bg-surface-secondary focus-visible:outline-focus aria-[current=true]:bg-surface-secondary flex w-full items-start gap-3 py-3 pe-4 text-left focus-visible:outline-2 focus-visible:-outline-offset-2",
                n.milestone ? "ps-6" : "ps-4",
              )}
            >
              <span className="mt-0.5">
                <StatusGlyph status={n.status} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{shortTitle(n)}</span>
                  {secs !== null ? (
                    <span className="text-muted shrink-0 font-mono text-[11px] tabular-nums">
                      {formatDuration(secs)}
                    </span>
                  ) : null}
                </span>
                <span className={cn("truncate text-xs", WORD[STATUS_TONE[n.status]])}>
                  {nowLine(n) ?? STATUS_LABEL[n.status]}
                </span>
                {rung ? (
                  <span className="text-muted flex items-center gap-1.5 text-[11px]">
                    <ProviderIcon backend={rung.backend} size="xs" />
                    {rung.model ? modelName(rung.model) : rung.backend}
                    {rung.effort ? ` · ${rung.effort}` : ""}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
