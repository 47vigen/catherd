import { Button, Disclosure, Label, Switch } from "@heroui/react";
import { type ReactNode, useState } from "react";

import type { Found } from "../-lib/issues";
import { parseAmount, patchFor, type Propose } from "../-lib/patch";
import { parseRung } from "../-lib/rung";
import type { SetupView } from "../../../../client";
import { ProviderIcon } from "../../../../components/provider-icon/ProviderIcon";
import { Term } from "../../../../components/term/Term";
import { LadderEditor } from "./LadderEditor";
import { Choice, IssueList, NumberText } from "./Section";

type Role = SetupView["roles"][number];

const MEANING: Record<Role["role"], ReactNode> = {
  architect: "Plans the run and splits it into milestones.",
  verifier: <>Checks each finished lane against the plan and the rules.</>,
  worker: "Writes the code of a lane.",
  reviewer: "Reads a lane's changes and sends back what is wrong.",
  "ui-reviewer": "Looks at the screens a change touches.",
  artist: "Makes images and other visual assets.",
  writer: "Writes the docs and the words in a change.",
  researcher: "Looks things up and reports what it found.",
  judge: <>Decides a question for the run, such as how to handle a failure.</>,
};

const ACCESS = [
  { id: "read-only", label: "Read only" },
  { id: "workspace-write", label: "Workspace" },
  { id: "full", label: "Full access" },
] as const;

const str = (n: number | undefined) => (n === undefined ? "" : String(n));

/** One role: what it does, whether it is on, its access, its ladder, and its network and timeouts. */
export function RoleRow({
  role,
  timeouts,
  issues,
  propose,
  disabled,
}: {
  role: Role;
  /** the profile's timeouts, shown as the placeholder of a role that sets none */
  timeouts: { idleMin: number; wallMin: number };
  issues: Found[];
  propose: Propose;
  disabled: boolean;
}) {
  const current = role.rungs.map((r) => r.rung);
  const [rungs, setRungs] = useState(current);
  const name = role.role;
  const scores: Record<string, number | null> = {
    ...Object.fromEntries(role.offered.map((p) => [p.rung, p.intelligence])),
    ...Object.fromEntries(role.rungs.map((r) => [r.rung, r.intelligence])),
  };
  const lead = rungs[0] ? parseRung(rungs[0]).backend : name;

  return (
    <fieldset aria-label={name} className="border-border bg-surface flex min-w-0 flex-col gap-3 rounded-sm border p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ProviderIcon backend={lead} size="md" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-mono text-sm font-medium">
            {name === "verifier" || name === "judge" ? <Term name={name}>{name}</Term> : name}
          </span>
          <span className="text-muted text-xs">{MEANING[name]}</span>
        </div>
        <Switch
          aria-label={`${name} enabled`}
          isSelected={role.enabled}
          isDisabled={disabled}
          onChange={(enabled) => propose(patchFor("roles", { role: name, enabled }))}
        >
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Content>
            <Label>{role.enabled ? "On" : "Off"}</Label>
          </Switch.Content>
        </Switch>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-muted text-xs">
          <Term name="access level">Access</Term>
        </span>
        <Choice
          label={`Access for ${name}`}
          value={role.access}
          options={ACCESS}
          disabled={disabled}
          onChange={(access) => propose(patchFor("roles", { role: name, access }))}
        />
      </div>

      {role.hostSet ? (
        <p className="text-muted bg-surface-secondary rounded-sm px-3 py-2 text-sm">
          Set by the app that runs catherd; choose it there.
        </p>
      ) : (
        <>
          <LadderEditor
            role={name}
            rungs={rungs}
            scores={scores}
            offered={role.offered}
            disabled={disabled}
            onChange={setRungs}
          />
          {JSON.stringify(rungs) !== JSON.stringify(current) ? (
            <div>
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
          <Limits
            key={JSON.stringify([role.network, role.timeouts])}
            role={role}
            timeouts={timeouts}
            propose={propose}
            disabled={disabled}
          />
        </>
      )}
      <IssueList issues={issues} />
    </fieldset>
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
  const initial = {
    idle: str(role.timeouts?.idleMin),
    wall: str(role.timeouts?.wallMin),
  };
  const [d, setD] = useState(initial);
  const idle = parseAmount(d.idle);
  const wall = parseAmount(d.wall);
  const valid = idle !== undefined && wall !== undefined;
  const msg = "Enter a number above zero, or leave empty.";
  return (
    <Disclosure>
      <Disclosure.Heading>
        <Button slot="trigger" size="sm" variant="ghost">
          Network and timeouts
          <Disclosure.Indicator />
        </Button>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="flex flex-col gap-3 pt-2">
          <Switch
            aria-label={`${role.role} network`}
            isSelected={role.network}
            isDisabled={disabled}
            onChange={(on) =>
              propose(
                patchFor("roles", {
                  role: role.role,
                  network: on ? null : false,
                }),
              )
            }
          >
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Content>
              <Label>Network access</Label>
            </Switch.Content>
          </Switch>
          <div className="flex flex-wrap items-end gap-4">
            <NumberText
              label={`Idle for ${role.role}`}
              unit="minutes without output"
              placeholder={String(timeouts.idleMin)}
              value={d.idle}
              invalid={idle === undefined ? msg : undefined}
              disabled={disabled}
              onChange={(v) => setD({ ...d, idle: v })}
            />
            <NumberText
              label={`Wall for ${role.role}`}
              unit="minutes in total"
              placeholder={String(timeouts.wallMin)}
              value={d.wall}
              invalid={wall === undefined ? msg : undefined}
              disabled={disabled}
              onChange={(v) => setD({ ...d, wall: v })}
            />
            <Button
              size="sm"
              variant="secondary"
              isDisabled={disabled || !valid || JSON.stringify(d) === JSON.stringify(initial)}
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
          </div>
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
