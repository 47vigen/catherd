import { Button, Drawer, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { type ReactNode, useState } from "react";

import type { Found } from "../-lib/issues";
import { parseAmount, patchFor, type Propose } from "../-lib/patch";
import { ACCESS, type Role, ROLE_MEANING, ROLE_NAME } from "../-lib/roles";
import { parseRung } from "../-lib/rung";
import { ProviderIcon } from "../../../../components/provider-icon/ProviderIcon";
import { LadderEditor } from "./LadderEditor";
import { IssueList, NumberText, OnOff, SwitchRow } from "./Section";

const str = (n: number | undefined) => (n === undefined ? "" : String(n));

function Part({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h3 className="label-caps text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** One role, edited in a side drawer: on or off, its models in the order tried, its access, its limits. */
export function RoleDrawer({
  role,
  timeouts,
  issues,
  propose,
  disabled,
  onClose,
}: {
  role: Role | undefined;
  /** the profile's timeouts, shown as the placeholder of a role that sets none */
  timeouts: { idleMin: number; wallMin: number };
  issues: Found[];
  propose: Propose;
  disabled: boolean;
  onClose(): void;
}) {
  return (
    <Drawer.Backdrop isOpen={role !== undefined} onOpenChange={(open) => !open && onClose()} variant="transparent">
      <Drawer.Content placement="right">
        <Drawer.Dialog aria-label={role ? ROLE_NAME[role.role] : "Role"} className="w-[min(560px,100vw)] max-w-full">
          <Drawer.CloseTrigger />
          {role ? (
            <Editor
              key={JSON.stringify(role)}
              role={role}
              timeouts={timeouts}
              issues={issues}
              propose={propose}
              disabled={disabled}
            />
          ) : null}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

function Editor({
  role,
  timeouts,
  issues,
  propose,
  disabled,
}: {
  role: Role;
  timeouts: { idleMin: number; wallMin: number };
  issues: Found[];
  propose: Propose;
  disabled: boolean;
}) {
  const name = role.role;
  const current = role.rungs.map((r) => r.rung);
  const [rungs, setRungs] = useState(current);
  const dirty = JSON.stringify(rungs) !== JSON.stringify(current);
  const access = ACCESS.find((a) => a.id === role.access);
  const lead = rungs[0] ? parseRung(rungs[0]).backend : name;

  return (
    <>
      <Drawer.Header className="flex flex-row items-center gap-3 pe-14">
        <ProviderIcon backend={lead} size="md" />
        <div className="flex min-w-0 flex-1 flex-col">
          <Drawer.Heading className="truncate">{ROLE_NAME[name]}</Drawer.Heading>
          <p className="text-muted text-xs">{ROLE_MEANING[name]}</p>
        </div>
        <span className="text-muted text-xs">{role.enabled ? "On" : "Off"}</span>
        <OnOff
          label={`${name} enabled`}
          isSelected={role.enabled}
          disabled={disabled}
          onChange={(enabled) => propose(patchFor("roles", { role: name, enabled }))}
        />
      </Drawer.Header>
      <Drawer.Body className="flex flex-col gap-7">
        {disabled ? (
          <p className="text-warning text-xs">Read only until you choose the app that runs catherd.</p>
        ) : null}
        <IssueList issues={issues} />
        <Part title="Models, in the order tried">
          {role.hostSet ? (
            <p className="border-border text-muted rounded-sm border border-dashed px-3 py-4 text-sm">
              The app that runs catherd picks this role&apos;s model. Change it there.
            </p>
          ) : (
            <>
              <LadderEditor
                role={ROLE_NAME[name]}
                rungs={rungs}
                offered={role.offered}
                disabled={disabled}
                onChange={setRungs}
              />
              {dirty ? (
                <div className="bg-accent/10 flex items-center gap-2 rounded-sm px-3 py-2">
                  <span className="text-muted flex-1 text-xs">Not saved yet.</span>
                  <Button size="sm" variant="ghost" onPress={() => setRungs(current)}>
                    Undo
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    isDisabled={disabled}
                    onPress={() => propose(patchFor("roles", { role: name, rungs }))}
                  >
                    Review changes
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Part>
        <Part title="Access">
          <ToggleButtonGroup
            aria-label={`Access for ${name}`}
            selectionMode="single"
            disallowEmptySelection
            fullWidth
            size="sm"
            isDisabled={disabled}
            selectedKeys={[role.access]}
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next !== undefined && next !== role.access)
                propose(patchFor("roles", { role: name, access: next as Role["access"] }));
            }}
          >
            {ACCESS.map((a, i) => (
              <ToggleButton
                key={a.id}
                id={a.id}
                className="data-[selected]:bg-accent data-[selected]:text-accent-foreground"
              >
                {i > 0 ? <ToggleButtonGroup.Separator /> : null}
                {a.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <p className={role.access === "full" ? "text-warning text-xs" : "text-muted text-xs"}>
            {access?.consequence}
          </p>
        </Part>
        {role.hostSet ? null : (
          <Limits
            key={JSON.stringify([role.network, role.timeouts])}
            role={role}
            timeouts={timeouts}
            propose={propose}
            disabled={disabled}
          />
        )}
      </Drawer.Body>
    </>
  );
}

function Limits({
  role,
  timeouts,
  propose,
  disabled,
}: {
  role: Role;
  timeouts: { idleMin: number; wallMin: number };
  propose: Propose;
  disabled: boolean;
}) {
  const initial = { idle: str(role.timeouts?.idleMin), wall: str(role.timeouts?.wallMin) };
  const [d, setD] = useState(initial);
  const idle = parseAmount(d.idle);
  const wall = parseAmount(d.wall);
  const valid = idle !== undefined && wall !== undefined;
  const msg = "Enter a number above zero, or leave empty.";
  return (
    <Part
      title="Limits"
      aside={
        JSON.stringify(d) === JSON.stringify(initial) ? null : (
          <Button
            size="sm"
            variant="primary"
            isDisabled={disabled || !valid}
            onPress={() =>
              propose(
                patchFor("roles", {
                  role: role.role,
                  timeouts: { idleMin: idle ?? null, wallMin: wall ?? null },
                }),
              )
            }
          >
            Review changes
          </Button>
        )
      }
    >
      <SwitchRow
        label="Internet access"
        ariaLabel={`${role.role} network`}
        hint={role.network ? "It can reach the internet." : "It works offline, with no internet."}
        isSelected={role.network}
        disabled={disabled}
        onChange={(on) => propose(patchFor("roles", { role: role.role, network: on ? null : false }))}
      />
      <div className="grid grid-cols-2 gap-4">
        <NumberText
          className="w-full"
          label="Stop when silent for"
          unit={`minutes. Empty uses the profile's ${timeouts.idleMin}.`}
          placeholder={String(timeouts.idleMin)}
          value={d.idle}
          invalid={idle === undefined ? msg : undefined}
          disabled={disabled}
          onChange={(v) => setD({ ...d, idle: v })}
        />
        <NumberText
          className="w-full"
          label="Stop after"
          unit={`minutes in all. Empty uses the profile's ${timeouts.wallMin}.`}
          placeholder={String(timeouts.wallMin)}
          value={d.wall}
          invalid={wall === undefined ? msg : undefined}
          disabled={disabled}
          onChange={(v) => setD({ ...d, wall: v })}
        />
      </div>
    </Part>
  );
}
