import { Button, Label, Modal, SearchField, Switch, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useState } from "react";

import { modelChoices, modelName, parseRung } from "../-lib/rung";
import type { IndexedPair } from "../../../../client";
import { ProviderIcon, backendName } from "../../../../components/provider-icon/ProviderIcon";

const ALL = "all";

/** What the index knows of a model beside its score, each part only when there is one. */
function facts(p: IndexedPair): string {
  return [
    p.price ? `$${p.price.input}/$${p.price.output} per M` : null,
    p.speed === null ? null : `${Math.round(p.speed)} tok/s`,
    p.cost.tier === 0 ? "on your plan" : null,
  ]
    .filter((x) => x !== null)
    .join(" · ");
}

/**
 * The models the index offers a role, strongest first, each with its efforts and their scores. Picking an effort
 * selects that pair; Add puts it after the role's models. The search, the provider filter and the action stay put
 * while the list scrolls. A model a newer version replaces shows only once "Older versions" is on.
 */
export function PairPicker({
  role,
  pairs,
  isOpen,
  onClose,
  onPick,
}: {
  role: string;
  pairs: IndexedPair[];
  isOpen: boolean;
  onClose(): void;
  onPick(rung: string): void;
}) {
  const [q, setQ] = useState("");
  const [older, setOlder] = useState(false);
  const [provider, setProvider] = useState(ALL);
  const [picked, setPicked] = useState<IndexedPair>();
  const needle = q.trim().toLowerCase();
  const choices = modelChoices(pairs.filter((p) => older || p.newer === null));
  const providers = [...new Set(choices.map((c) => c.backend))];
  const shown = choices.filter(
    (c) =>
      (provider === ALL || c.backend === provider) &&
      `${c.backend} ${c.model} ${modelName(c.model)}`.toLowerCase().includes(needle),
  );
  const pickedName = picked ? `${modelName(parseRung(picked.rung).model)} · ${parseRung(picked.rung).effort}` : null;

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-label={`Add a model to ${role}`} className="max-h-[85dvh] sm:max-w-2xl">
          <Modal.CloseTrigger />
          <Modal.Header className="border-border flex flex-col gap-3 border-b pb-3">
            <div className="flex flex-col gap-1">
              <Modal.Heading>Add a model to {role}</Modal.Heading>
              <p className="text-muted text-xs">
                It is tried after the models already listed. Pick a model's effort; a higher score is more capable.
              </p>
            </div>
            {pairs.length > 0 ? (
              <>
                <div className="flex items-center gap-3">
                  <SearchField aria-label="Search models" value={q} onChange={setQ} className="flex-1">
                    <SearchField.Group>
                      <SearchField.SearchIcon />
                      <SearchField.Input placeholder="Search models" />
                      <SearchField.ClearButton />
                    </SearchField.Group>
                  </SearchField>
                  {pairs.some((p) => p.newer !== null) ? (
                    <Switch size="sm" isSelected={older} onChange={setOlder} className="shrink-0">
                      <Switch.Content>
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                        <Label className="text-xs">Older versions</Label>
                      </Switch.Content>
                    </Switch>
                  ) : null}
                </div>
                {providers.length > 1 ? (
                  // scrolls sideways when the providers outgrow the dialog
                  <div className="-mx-1 overflow-x-auto px-1">
                    <ToggleButtonGroup
                      aria-label="Provider"
                      size="sm"
                      selectionMode="single"
                      disallowEmptySelection
                      selectedKeys={new Set([provider])}
                      onSelectionChange={(k) => setProvider(String([...k][0] ?? ALL))}
                    >
                      {[ALL, ...providers].map((b, i) => (
                        <ToggleButton key={b} id={b} className="h-7 gap-1.5 text-xs">
                          {i > 0 ? <ToggleButtonGroup.Separator /> : null}
                          {b === ALL ? "All" : <ProviderIcon backend={b} size="xs" />}
                          {b === ALL ? null : backendName(b)}
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                  </div>
                ) : null}
              </>
            ) : null}
          </Modal.Header>
          <Modal.Body className="flex flex-col py-1">
            {pairs.length === 0 ? (
              <p className="text-muted py-3 text-sm">
                No indexed pair fits this role. Run catherd catalog sync, then reload.
              </p>
            ) : shown.length === 0 ? (
              <p className="text-muted py-3 text-sm">No model matches.</p>
            ) : (
              <ul aria-label="Models" className="divide-border divide-y">
                {shown.map((c) => {
                  const name = modelName(c.model);
                  return (
                    <li key={`${c.backend}:${c.model}`} className="flex flex-col gap-2 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ProviderIcon backend={c.backend} size="sm" />
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate text-sm font-medium">{name}</span>
                            <span className="text-muted truncate text-xs">
                              {[`via ${backendName(c.backend)}`, facts(c.best), c.newer ? `Newer: ${c.newer}` : null]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </div>
                        </div>
                        <span className="text-muted shrink-0 font-mono text-xs tabular-nums">
                          up to {c.best.intelligence.toFixed(1)}
                        </span>
                      </div>
                      <ToggleButtonGroup
                        aria-label={`${name} via ${backendName(c.backend)}, effort`}
                        size="sm"
                        selectionMode="single"
                        selectedKeys={new Set(picked ? [picked.rung] : [])}
                        onSelectionChange={(k) => setPicked(c.efforts.find((p) => k.has(p.rung)))}
                        className="flex-wrap justify-start self-start"
                      >
                        {c.efforts.map((p, i) => (
                          <ToggleButton key={p.rung} id={p.rung} className="h-7 gap-1.5 text-xs">
                            {i > 0 ? <ToggleButtonGroup.Separator /> : null}
                            {parseRung(p.rung).effort ?? "default"}
                            <span className="text-muted font-mono tabular-nums">{p.intelligence.toFixed(1)}</span>
                          </ToggleButton>
                        ))}
                      </ToggleButtonGroup>
                    </li>
                  );
                })}
              </ul>
            )}
          </Modal.Body>
          <Modal.Footer className="border-border flex items-center justify-between gap-3 border-t pt-3">
            <span className="text-muted min-w-0 truncate text-xs">
              {picked ? `${pickedName}, score ${picked.intelligence.toFixed(1)}` : "No model picked yet."}
            </span>
            <div className="flex shrink-0 gap-2">
              <Button variant="tertiary" size="sm" onPress={onClose}>
                Cancel
              </Button>
              <Button size="sm" isDisabled={!picked} onPress={() => picked && onPick(picked.rung)}>
                Add
              </Button>
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
