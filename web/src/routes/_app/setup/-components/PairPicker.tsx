import { Description, Header, Label, ListBox, Modal, SearchField } from "@heroui/react";
import { useState } from "react";

import { modelName, pairLine, parseRung, providerGroups } from "../-lib/rung";
import type { IndexedPair } from "../../../../client";
import { ProviderIcon, backendName } from "../../../../components/provider-icon/ProviderIcon";

/** The pairs the index offers a role, grouped by provider, each with its score, price and speed. Picking one adds it. */
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
  const needle = q.trim().toLowerCase();
  const shown = pairs.filter((p) => `${p.rung} ${modelName(parseRung(p.rung).model)}`.toLowerCase().includes(needle));
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-label={`Add a model to ${role}`}>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Add a model to {role}</Modal.Heading>
            <p className="text-muted text-xs">
              Pick the model to try after the ones already listed. Higher benchmark is more capable.
            </p>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            {pairs.length === 0 ? (
              <p className="text-muted text-sm">
                No indexed pair fits this role. Run catherd catalog sync, then reload.
              </p>
            ) : (
              <>
                <SearchField aria-label="Search models" value={q} onChange={setQ}>
                  <SearchField.Group>
                    <SearchField.SearchIcon />
                    <SearchField.Input placeholder="Search models" />
                    <SearchField.ClearButton />
                  </SearchField.Group>
                </SearchField>
                <ListBox aria-label="Indexed pairs" onAction={(key) => onPick(String(key))}>
                  {providerGroups(shown).map((g) => (
                    <ListBox.Section key={g.backend}>
                      <Header className="flex items-center gap-2 py-1">
                        <ProviderIcon backend={g.backend} size="xs" />
                        {backendName(g.backend)}
                      </Header>
                      {g.pairs.map((p) => {
                        const r = parseRung(p.rung);
                        return (
                          <ListBox.Item key={p.rung} id={p.rung} textValue={p.rung}>
                            <div className="flex min-w-0 flex-1 flex-col">
                              <Label className="text-sm">
                                {modelName(r.model)}
                                {r.effort ? <span className="text-muted"> · {r.effort}</span> : null}
                              </Label>
                              <Description className="text-xs">{pairLine(p)}</Description>
                            </div>
                          </ListBox.Item>
                        );
                      })}
                    </ListBox.Section>
                  ))}
                </ListBox>
                {shown.length === 0 ? <p className="text-muted text-sm">No model matches.</p> : null}
              </>
            )}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
