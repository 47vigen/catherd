import { ArrowDown, ArrowUp, Bars } from "@gravity-ui/icons";
import { Button, Chip } from "@heroui/react";
import { useState } from "react";
import { GridList, GridListItem, useDragAndDrop } from "react-aria-components";

import { dropAt, moveBy, parseRung } from "../-lib/rung";
import type { IndexedPair } from "../../../../client";
import { Meter } from "../../../../components/charts/Meter";
import { ProviderIcon } from "../../../../components/provider-icon/ProviderIcon";
import { PairPicker } from "./PairPicker";

/**
 * A role's rungs as connected steps, lowest first: drag a step (or use Move up and Move down), add one from the
 * index, remove one. It edits a draft; the role row reviews it.
 */
export function LadderEditor({
  role,
  rungs,
  scores,
  offered,
  disabled,
  onChange,
}: {
  role: string;
  rungs: string[];
  /** the indexed intelligence of every rung known so far (null when the index has none) */
  scores: Record<string, number | null>;
  offered: IndexedPair[];
  disabled: boolean;
  onChange(next: string[]): void;
}) {
  const [adding, setAdding] = useState(false);
  const top = Math.max(1, ...Object.values(scores).map((n) => n ?? 0));
  const { dragAndDropHooks } = useDragAndDrop({
    isDisabled: disabled,
    getItems: (keys) => [...keys].map((k) => ({ "text/plain": String(k) })),
    onReorder: (e) =>
      onChange(
        dropAt(
          rungs,
          [...e.keys].map(String),
          String(e.target.key),
          e.target.dropPosition === "before" ? "before" : "after",
        ),
      ),
  });
  const free = offered.filter((p) => !rungs.includes(p.rung));

  return (
    <div className="flex flex-col gap-2">
      {rungs.length === 0 ? (
        <p className="text-muted text-sm">No rungs.</p>
      ) : (
        <GridList
          aria-label={`${role} ladder`}
          dragAndDropHooks={dragAndDropHooks}
          className="flex flex-col outline-none"
        >
          {rungs.map((rung, i) => {
            const r = parseRung(rung);
            const score = scores[rung] ?? null;
            return (
              <GridListItem
                key={rung}
                id={rung}
                textValue={rung}
                className="group data-[drop-target]:bg-accent/10 data-[focus-visible]:outline-focus relative flex items-center gap-3 rounded-sm py-1.5 pr-1 pl-9 outline-none data-[dragging]:opacity-50 data-[focus-visible]:outline-2"
              >
                <span
                  aria-hidden="true"
                  className="bg-border absolute top-0 bottom-0 left-3.5 w-px group-first:top-1/2 group-last:bottom-1/2"
                />
                <span
                  aria-hidden="true"
                  className="border-accent bg-surface absolute left-2.5 size-2.5 rounded-full border-2"
                />
                <ProviderIcon backend={r.backend} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[13px]" title={rung}>
                    {r.model}
                  </span>
                  <span className="text-muted text-[11px]">Step {i + 1}</span>
                </span>
                {r.effort ? (
                  <Chip size="sm" variant="soft" className="font-mono text-[11px]">
                    {r.effort}
                  </Chip>
                ) : null}
                <span className="flex w-36 shrink-0 items-center gap-2 max-sm:hidden">
                  {score === null ? (
                    <span className="text-muted text-xs">not indexed</span>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1">
                        <Meter value={Math.min(1, score / top)} label={`Intelligence of ${rung}`} />
                      </span>
                      <span className="text-muted font-mono text-xs tabular-nums">{score.toFixed(1)}</span>
                    </>
                  )}
                </span>
                <span className="flex shrink-0 items-center">
                  <Button
                    slot="drag"
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={`Drag ${rung}`}
                    isDisabled={disabled}
                  >
                    <Bars aria-hidden="true" />
                  </Button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={`Move up ${rung}`}
                    isDisabled={disabled || i === 0}
                    onPress={() => onChange(moveBy(rungs, rung, -1))}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={`Move down ${rung}`}
                    isDisabled={disabled || i === rungs.length - 1}
                    onPress={() => onChange(moveBy(rungs, rung, 1))}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${rung}`}
                    isDisabled={disabled}
                    onPress={() => onChange(rungs.filter((x) => x !== rung))}
                  >
                    Remove
                  </Button>
                </span>
              </GridListItem>
            );
          })}
        </GridList>
      )}
      <div>
        <Button size="sm" variant="secondary" isDisabled={disabled} onPress={() => setAdding(true)}>
          Add rung
        </Button>
      </div>
      <PairPicker
        key={String(adding)}
        role={role}
        pairs={free}
        isOpen={adding}
        onClose={() => setAdding(false)}
        onPick={(rung) => {
          onChange([...rungs, rung]);
          setAdding(false);
        }}
      />
    </div>
  );
}
