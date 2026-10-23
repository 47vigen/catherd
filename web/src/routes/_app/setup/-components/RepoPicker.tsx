import { Label, ListBox, Select } from "@heroui/react";

import type { SetupView } from "../../../../client";

export const GLOBAL = "global";

/** Which profile Setup edits: the one a repo runs on, or the global default (the active profile). */
export function RepoPicker({ view, onChange }: { view: SetupView; onChange(repo: string): void }) {
  const options = [{ id: GLOBAL, label: "Global default" }, ...view.repos.map((r) => ({ id: r.path, label: r.path }))];
  return (
    <Select
      aria-label="Repo"
      className="w-72 max-w-full"
      value={view.repo ?? GLOBAL}
      onChange={(key) => onChange(String(key))}
    >
      <Label className="sr-only">Repo</Label>
      <Select.Trigger className="h-8 min-h-8 text-[13px]">
        <Select.Value className="truncate" />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="min-w-72">
        <ListBox aria-label="Repo">
          {options.map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
              <span className={o.id === GLOBAL ? "" : "font-mono text-xs"}>{o.label}</span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
