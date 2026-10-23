import { Description, Header, Label, ListBox, Modal, SearchField } from "@heroui/react";
import { useState } from "react";

import { pairLine, parseRung, providerGroups } from "../-lib/rung";
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
  const shown = pairs.filter((p) => p.rung.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-label={`Add a rung to ${role}`}>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Add a rung to {role}</Modal.Heading>
            <p className="text-muted text-xs">Each pair is a backend, a model and an effort the catalog has scored.</p>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            {pairs.length === 0 ? (
              <p className="text-muted text-sm">
                No indexed pair fits this role. Run catherd catalog sync, then reload.
              </p>
            ) : (
              <>
                <SearchField aria-label="Filter pairs" value={q} onChange={setQ}>
                  <SearchField.Group>
                    <SearchField.SearchIcon />
                    <SearchField.Input placeholder="Filter pairs" />
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
                            <Label className="font-mono text-xs">
                              {r.model}
                              {r.effort ? ` · ${r.effort}` : ""}
                            </Label>
                            <Description>{pairLine(p)}</Description>
                          </ListBox.Item>
                        );
                      })}
                    </ListBox.Section>
                  ))}
                </ListBox>
                {shown.length === 0 ? <p className="text-muted text-sm">No pair matches.</p> : null}
              </>
            )}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
