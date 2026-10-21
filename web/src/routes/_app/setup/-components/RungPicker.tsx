import { Alert, Button, Description, Drawer, Label, ListBox, SearchField, toast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { filterPairs, pairLine } from "../-lib/rungs";
import type { SetupView } from "../../../../client";
import { setRoleRungsMutation } from "../../../../client/@tanstack/react-query.gen";
import { errorMessage } from "../../../../lib/api";
import { invalidateOps } from "../../../../lib/query";

type Role = SetupView["roles"][number];

/** The drawer of one role: its indexed pairs, the current rungs ticked; a save goes through the profile service. */
export function RungPicker({ role, onClose }: { role: Role | undefined; onClose(): void }) {
  return (
    <Drawer.Backdrop isOpen={role !== undefined} onOpenChange={(open) => !open && onClose()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>{role ? <Picker key={role.role} role={role} onClose={onClose} /> : null}</Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

function Picker({ role, onClose }: { role: Role; onClose(): void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState(() => new Set(role.rungs.map((r) => r.rung)));
  const save = useMutation({
    ...setRoleRungsMutation(),
    onSuccess: async (r) => {
      if (!r.saved) return;
      toast.success(`Saved. ${role.role} climbs ${picked.size} rungs.`);
      await invalidateOps(qc, "getSetup");
      onClose();
    },
  });
  const issues = save.data && !save.data.saved ? save.data.errors : [];

  return (
    <>
      <Drawer.Header className="border-border border-b pb-4">
        <Drawer.Heading>{role.role}</Drawer.Heading>
        <p className="text-muted text-xs">Pick the rungs this role climbs. They run from the lowest intelligence up.</p>
      </Drawer.Header>
      <Drawer.Body className="flex flex-col gap-4 py-5">
        {role.offered.length === 0 ? (
          <p className="text-muted text-sm">No indexed pair fits this role. Run catherd catalog sync, then reload.</p>
        ) : (
          <>
            <SearchField aria-label="Filter pairs" value={q} onChange={setQ}>
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Filter pairs" />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            <ListBox
              aria-label="Indexed pairs"
              selectionMode="multiple"
              selectedKeys={picked}
              onSelectionChange={(keys) =>
                setPicked(new Set(keys === "all" ? role.offered.map((p) => p.rung) : [...keys].map(String)))
              }
              className="max-h-[60vh] overflow-y-auto"
            >
              {filterPairs(role.offered, q).map((p) => (
                <ListBox.Item key={p.rung} id={p.rung} textValue={p.rung}>
                  <Label className="font-mono text-xs">{p.rung}</Label>
                  <Description>{pairLine(p)}</Description>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </>
        )}
        {save.error ? (
          <Alert status="danger" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{errorMessage(save.error)}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        {issues.length > 0 ? (
          <Alert status="danger" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Not saved</Alert.Title>
              {issues.map((i, n) => (
                <Alert.Description key={n}>
                  {i.path}: {i.message}
                  {i.fix ? ` (${i.fix})` : ""}
                </Alert.Description>
              ))}
            </Alert.Content>
          </Alert>
        ) : null}
      </Drawer.Body>
      <Drawer.Footer className="border-border border-t">
        <Button size="sm" variant="secondary" onPress={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          isPending={save.isPending}
          isDisabled={role.offered.length === 0}
          onPress={() => save.mutate({ path: { role: role.role }, body: { rungs: [...picked] } })}
        >
          Save
        </Button>
      </Drawer.Footer>
    </>
  );
}
