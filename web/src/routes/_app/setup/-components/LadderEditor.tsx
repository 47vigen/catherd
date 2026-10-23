import { ArrowDown, Ellipsis, Grip, Plus } from "@gravity-ui/icons";
import { Button, Dropdown, Label, ListBox, Select } from "@heroui/react";
import { useState } from "react";
import { GridList, GridListItem, useDragAndDrop } from "react-aria-components";

import { dropAt, effortsOf, modelName, moveBy, parseRung, withEffort } from "../-lib/rung";
import type { IndexedPair } from "../../../../client";
import { ProviderIcon, backendName } from "../../../../components/provider-icon/ProviderIcon";
import { PairPicker } from "./PairPicker";

function EffortPick({
  rung,
  rungs,
  offered,
  disabled,
  onPick,
}: {
  rung: string;
  rungs: string[];
  offered: IndexedPair[];
  disabled: boolean;
  onPick(effort: string): void;
}) {
  const { effort } = parseRung(rung);
  const efforts = effortsOf(rung, offered);
  if (effort === null) return null;
  if (efforts.length < 2) return <span className="text-muted w-28 shrink-0 text-xs">{effort} effort</span>;
  return (
    <Select
      aria-label={`Effort for ${rung}`}
      className="w-24 shrink-0 sm:w-28"
      value={effort}
      isDisabled={disabled}
      disabledKeys={efforts.filter((e) => e !== effort && rungs.includes(withEffort(rung, e)))}
      onChange={(k) => onPick(String(k))}
    >
      <Select.Trigger className="h-8 min-h-8 text-[13px]">
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={`Effort for ${rung}`}>
          {efforts.map((e) => (
            <ListBox.Item key={e} id={e} textValue={e}>
              {e}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/**
 * A role's models in the order they are tried, as a numbered list: drag a model (or use its menu) to reorder, change
 * its effort, remove it, add one from the index. It edits a draft; the drawer reviews it.
 */
export function LadderEditor({
  role,
  rungs,
  offered,
  disabled,
  onChange,
}: {
  role: string;
  rungs: string[];
  offered: IndexedPair[];
  disabled: boolean;
  onChange(next: string[]): void;
}) {
  const [adding, setAdding] = useState(false);
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
        <p className="border-border text-muted rounded-sm border border-dashed px-3 py-4 text-center text-sm">
          No model yet. Add the one this role should try first.
        </p>
      ) : (
        <GridList
          aria-label={`${role} models`}
          dragAndDropHooks={dragAndDropHooks}
          className="flex flex-col outline-none"
        >
          {rungs.map((rung, i) => {
            const r = parseRung(rung);
            return (
              <GridListItem
                key={rung}
                id={rung}
                textValue={rung}
                className="group flex flex-col outline-none data-[dragging]:opacity-50"
              >
                {i > 0 ? (
                  <span className="text-muted flex h-7 items-center gap-1.5 pl-[3.25rem] text-xs">
                    <ArrowDown aria-hidden="true" className="size-3" />
                    then, if it fails
                  </span>
                ) : null}
                <div className="border-border bg-surface group-data-[drop-target]:border-accent group-data-[focus-visible]:outline-focus flex min-w-0 items-center gap-2 rounded-sm border py-2 pr-2 pl-1 group-data-[focus-visible]:outline-2">
                  <Button
                    slot="drag"
                    isIconOnly
                    size="sm"
                    variant="ghost"
                    aria-label={`Drag ${rung}`}
                    isDisabled={disabled}
                    className="text-muted cursor-grab"
                  >
                    <Grip aria-hidden="true" />
                  </Button>
                  <span className="bg-surface-secondary text-muted flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums max-sm:hidden">
                    {i + 1}
                  </span>
                  <ProviderIcon backend={r.backend} size="md" className="sm:ml-1" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium" title={rung}>
                      {modelName(r.model)}
                    </span>
                    <span className="text-muted truncate text-xs">
                      {i === 0 ? "Tried first" : `Fallback ${i}`} · via {backendName(r.backend)}
                    </span>
                  </span>
                  <EffortPick
                    rung={rung}
                    rungs={rungs}
                    offered={offered}
                    disabled={disabled}
                    onPick={(e) => onChange(rungs.map((x) => (x === rung ? withEffort(rung, e) : x)))}
                  />
                  <Dropdown>
                    <Button isIconOnly size="sm" variant="ghost" aria-label={`More for ${rung}`} isDisabled={disabled}>
                      <Ellipsis aria-hidden="true" />
                    </Button>
                    <Dropdown.Popover placement="bottom end">
                      <Dropdown.Menu
                        aria-label={`More for ${rung}`}
                        disabledKeys={[...(i === 0 ? ["up"] : []), ...(i === rungs.length - 1 ? ["down"] : [])]}
                        onAction={(k) => {
                          if (k === "up") onChange(moveBy(rungs, rung, -1));
                          else if (k === "down") onChange(moveBy(rungs, rung, 1));
                          else onChange(rungs.filter((x) => x !== rung));
                        }}
                      >
                        <Dropdown.Item id="up" textValue="Move up">
                          <Label>Move up</Label>
                        </Dropdown.Item>
                        <Dropdown.Item id="down" textValue="Move down">
                          <Label>Move down</Label>
                        </Dropdown.Item>
                        <Dropdown.Item id="remove" textValue="Remove" variant="danger">
                          <Label>Remove</Label>
                        </Dropdown.Item>
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </div>
              </GridListItem>
            );
          })}
        </GridList>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="border-border w-full border border-dashed"
        isDisabled={disabled}
        onPress={() => setAdding(true)}
      >
        <Plus aria-hidden="true" />
        {rungs.length === 0 ? "Add a model" : "Add a fallback model"}
      </Button>
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
