import {
  Button,
  Checkbox,
  CheckboxGroup,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  TextField,
  toast,
} from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { type Found, issuesAt } from "../-lib/issues";
import { parseAmount, patchFor, type Propose } from "../-lib/patch";
import { offeredRungs } from "../-lib/rung";
import type { SetupView } from "../../../../client";
import { setNotifyUrlMutation } from "../../../../client/@tanstack/react-query.gen";
import { ProviderIcon, backendName } from "../../../../components/provider-icon/ProviderIcon";
import { Term } from "../../../../components/term/Term";
import { errorMessage } from "../../../../lib/api";
import { invalidateOps } from "../../../../lib/query";
import { Choice, NumberText, SettingSection } from "./Section";

type Settings = SetupView["settings"];
type Props = {
  view: SetupView;
  issues: Found[];
  propose: Propose;
  disabled: boolean;
};

const str = (n: number | undefined) => (n === undefined ? "" : String(n));
const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
type Effort = (typeof EFFORTS)[number];
const BILLING = [
  { id: "chatgpt-plan", label: "ChatGPT plan" },
  { id: "claude-plan", label: "Claude plan" },
  { id: "subscription", label: "Subscription" },
  { id: "metered", label: "Metered" },
] as const;
const MOMENTS = [
  { id: "milestone", label: "A milestone lands" },
  { id: "finish", label: "A run finishes" },
  { id: "blocked", label: "A run needs you" },
] as const;

/** Every profile setting except the roles, each section with its own review. */
export function SettingsSections({ view, issues, propose, disabled }: Props) {
  const s = view.settings;
  const p = { issues, propose, disabled };
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <ObjectiveSection key={`o${s.objective}`} value={s.objective} {...p} />
      <JevSection key={`j${s.jev}`} value={s.jev} {...p} />
      <BudgetSection key={`b${JSON.stringify(s.budget)}`} value={s.budget} {...p} />
      <TimeoutsSection key={`t${JSON.stringify(s.timeouts)}`} value={s.timeouts} {...p} />
      <FailoverSection key={`f${JSON.stringify(s.failover)}`} value={s.failover} roles={view.roles} {...p} />
      <EffortSection key={`e${JSON.stringify(s.maxEffort)}`} value={s.maxEffort} {...p} />
      <BarsSection key={`d${JSON.stringify(s.bars)}`} value={s.bars} {...p} />
      <LimitsSection key={`l${JSON.stringify([s.heavy, s.memory])}`} value={s} {...p} />
      <PreflightSection key={`p${s.preflightConfirm}`} value={s.preflightConfirm} {...p} />
      <NotificationsSection key={`n${JSON.stringify(s.notify)}`} value={s.notify} url={view.notifyUrl} {...p} />
      <BillingSection key={`i${JSON.stringify(s.billing)}`} value={s.billing} {...p} />
      <IsolationSection key={`s${JSON.stringify(s.isolated)}`} value={s.isolated} {...p} />
    </div>
  );
}

type SectionProps<T> = {
  value: T;
  issues: Found[];
  propose: Propose;
  disabled: boolean;
};

function ObjectiveSection({ value, issues, propose, disabled }: SectionProps<Settings["objective"]>) {
  const [draft, setDraft] = useState(value);
  return (
    <SettingSection
      id="objective"
      title={<Term name="objective">Objective</Term>}
      meaning="What routing favours when two rungs both fit: the cheaper one or the faster one."
      issues={issuesAt(issues, "objective")}
      dirty={draft !== value}
      disabled={disabled}
      onReview={() => propose(patchFor("objective", { objective: draft }))}
    >
      <Choice<"cost" | "speed">
        label="Objective"
        value={draft}
        onChange={setDraft}
        disabled={disabled}
        options={[
          {
            id: "cost",
            label: "Cost",
            description: "Prefer the cheapest rung that fits.",
          },
          {
            id: "speed",
            label: "Speed",
            description: "Prefer the fastest rung that fits.",
          },
        ]}
      />
    </SettingSection>
  );
}

function JevSection({ value, issues, propose, disabled }: SectionProps<Settings["jev"]>) {
  const [draft, setDraft] = useState(value);
  return (
    <SettingSection
      id="jev"
      title={<Term name="Jev">Jev</Term>}
      meaning="Let the advisor pick the model and effort of each lane, or keep to your ladders as they are."
      issues={issuesAt(issues, "jev")}
      dirty={draft !== value}
      disabled={disabled}
      onReview={() => propose(patchFor("jev", { use: draft }))}
    >
      <Choice<"auto" | "off">
        label="Jev"
        value={draft}
        onChange={setDraft}
        disabled={disabled}
        options={[
          { id: "auto", label: "Automatic" },
          { id: "off", label: "Off" },
        ]}
      />
    </SettingSection>
  );
}

function BudgetSection({ value, issues, propose, disabled }: SectionProps<Settings["budget"]>) {
  const initial = {
    minutes: str(value.minutes),
    tokens: str(value.tokens),
    usd: str(value.usd),
  };
  const [d, setD] = useState(initial);
  const parsed = {
    minutes: parseAmount(d.minutes),
    tokens: parseAmount(d.tokens),
    usd: parseAmount(d.usd),
  };
  const bad = (k: keyof typeof parsed) =>
    parsed[k] === undefined ? "Enter a number above zero, or leave empty." : undefined;
  const valid = Object.values(parsed).every((x) => x !== undefined);
  return (
    <SettingSection
      id="budget"
      title="Budget"
      meaning="How much a run may spend before it parks and asks you. Leave a field empty for no limit."
      issues={issuesAt(issues, "budget")}
      dirty={changed(d, initial)}
      valid={valid}
      disabled={disabled}
      onReview={() =>
        propose(
          patchFor("budget", {
            minutes: parsed.minutes ?? null,
            tokens: parsed.tokens ?? null,
            usd: parsed.usd ?? null,
          }),
        )
      }
    >
      <div className="flex flex-wrap gap-4">
        <NumberText
          label="Minutes"
          unit="of work time"
          value={d.minutes}
          invalid={bad("minutes")}
          disabled={disabled}
          onChange={(v) => setD({ ...d, minutes: v })}
        />
        <NumberText
          label="Tokens"
          unit="in and out"
          value={d.tokens}
          invalid={bad("tokens")}
          disabled={disabled}
          onChange={(v) => setD({ ...d, tokens: v })}
        />
        <NumberText
          label="USD"
          unit="of metered spend"
          value={d.usd}
          invalid={bad("usd")}
          disabled={disabled}
          onChange={(v) => setD({ ...d, usd: v })}
        />
      </div>
    </SettingSection>
  );
}

function TimeoutsSection({ value, issues, propose, disabled }: SectionProps<Settings["timeouts"]>) {
  const initial = { idle: str(value.idleMin), wall: str(value.wallMin) };
  const [d, setD] = useState(initial);
  const idle = parseAmount(d.idle);
  const wall = parseAmount(d.wall);
  const msg = "Enter a number above zero.";
  return (
    <SettingSection
      id="timeouts"
      title="Timeouts"
      meaning="How long a dispatch may stay silent, and how long it may run in all, before catherd stops it. A role can set its own."
      issues={issuesAt(issues, "timeouts")}
      dirty={changed(d, initial)}
      valid={typeof idle === "number" && typeof wall === "number"}
      disabled={disabled}
      onReview={() =>
        propose(
          patchFor("timeouts", {
            idleMin: idle as number,
            wallMin: wall as number,
          }),
        )
      }
    >
      <div className="flex flex-wrap gap-4">
        <NumberText
          label="Idle"
          unit="minutes without output"
          value={d.idle}
          invalid={typeof idle === "number" ? undefined : msg}
          disabled={disabled}
          onChange={(v) => setD({ ...d, idle: v })}
        />
        <NumberText
          label="Wall"
          unit="minutes in total"
          value={d.wall}
          invalid={typeof wall === "number" ? undefined : msg}
          disabled={disabled}
          onChange={(v) => setD({ ...d, wall: v })}
        />
      </div>
    </SettingSection>
  );
}

function FailoverSection({
  value,
  roles,
  issues,
  propose,
  disabled,
}: SectionProps<Settings["failover"]> & { roles: SetupView["roles"] }) {
  const [pairs, setPairs] = useState(value);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const add = () => {
    setPairs({ ...pairs, [from.trim()]: to.trim() });
    setFrom("");
    setTo("");
  };
  return (
    <SettingSection
      id="failover"
      title={<Term name="failover">Failover</Term>}
      meaning="The stand-in rung catherd switches to when a rung hits a provider limit."
      issues={issuesAt(issues, "failover")}
      dirty={changed(pairs, value)}
      disabled={disabled}
      onReview={() => propose(patchFor("failover", { pairs, previous: value }))}
    >
      <datalist id="setup-rungs">
        {offeredRungs(roles).map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </datalist>
      {Object.keys(pairs).length === 0 ? <p className="text-muted text-sm">No stand-ins are set.</p> : null}
      <ul className="flex flex-col gap-1.5">
        {Object.entries(pairs).map(([a, b]) => (
          <li key={a} className="flex items-center gap-2 text-xs">
            <ProviderIcon backend={a} size="xs" />
            <span className="min-w-0 truncate font-mono">{a}</span>
            <span aria-hidden="true" className="text-muted">
              →
            </span>
            <ProviderIcon backend={b} size="xs" />
            <span className="min-w-0 truncate font-mono">{b}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              isDisabled={disabled}
              aria-label={`Remove failover for ${a}`}
              onPress={() => setPairs(Object.fromEntries(Object.entries(pairs).filter(([k]) => k !== a)))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <TextField value={from} onChange={setFrom} isDisabled={disabled} className="min-w-48 flex-1">
          <Label>When this rung fails</Label>
          <Input list="setup-rungs" placeholder="codex:gpt-6-sol#high" />
        </TextField>
        <TextField value={to} onChange={setTo} isDisabled={disabled} className="min-w-48 flex-1">
          <Label>Use this rung</Label>
          <Input list="setup-rungs" placeholder="codex:gpt-6-luna#high" />
        </TextField>
        <Button
          size="sm"
          variant="secondary"
          isDisabled={disabled || from.trim() === "" || to.trim() === ""}
          onPress={add}
        >
          Add pair
        </Button>
      </div>
    </SettingSection>
  );
}

function EffortSelect({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: Effort;
  onChange(v: Effort): void;
  disabled: boolean;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      onChange={(k) => onChange(String(k) as Effort)}
      isDisabled={disabled}
      className="w-32"
    >
      <Select.Trigger className="h-8 min-h-8 text-[13px]">
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={label}>
          {EFFORTS.map((e) => (
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

function EffortSection({ value, issues, propose, disabled }: SectionProps<Settings["maxEffort"]>) {
  const [efforts, setEfforts] = useState(value as Record<string, Effort>);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort>("high");
  return (
    <SettingSection
      id="effort"
      title={<Term name="effort">Max effort</Term>}
      meaning="The highest effort catherd asks of a model, whatever a ladder says. Models not listed have no ceiling."
      issues={issuesAt(issues, "effort")}
      dirty={changed(efforts, value)}
      disabled={disabled}
      onReview={() => propose(patchFor("effort", { efforts, previous: value }))}
    >
      {Object.keys(efforts).length === 0 ? <p className="text-muted text-sm">No ceilings are set.</p> : null}
      <ul className="flex flex-col gap-1.5">
        {Object.entries(efforts).map(([k, e]) => (
          <li key={k} className="flex items-center gap-2 text-xs">
            <ProviderIcon backend={k} size="xs" />
            <span className="min-w-0 flex-1 truncate font-mono">{k}</span>
            <EffortSelect
              label={`Max effort for ${k}`}
              value={e}
              disabled={disabled}
              onChange={(v) => setEfforts({ ...efforts, [k]: v })}
            />
            <Button
              size="sm"
              variant="ghost"
              isDisabled={disabled}
              aria-label={`Remove ceiling for ${k}`}
              onPress={() => setEfforts(Object.fromEntries(Object.entries(efforts).filter(([x]) => x !== k)))}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <TextField value={model} onChange={setModel} isDisabled={disabled} className="min-w-48 flex-1">
          <Label>Model</Label>
          <Input placeholder="codex:gpt-6-sol" />
        </TextField>
        <EffortSelect label="Ceiling for the new model" value={effort} onChange={setEffort} disabled={disabled} />
        <Button
          size="sm"
          variant="secondary"
          isDisabled={disabled || model.trim() === ""}
          onPress={() => {
            setEfforts({ ...efforts, [model.trim()]: effort });
            setModel("");
          }}
        >
          Add ceiling
        </Button>
      </div>
    </SettingSection>
  );
}

const parseBar = (t: string): number | undefined => {
  const n = Number(t.trim());
  return t.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
};

function BarsSection({ value, issues, propose, disabled }: SectionProps<Settings["bars"]>) {
  const initial = Object.fromEntries(Object.entries(value).map(([k, n]) => [k, String(n)]));
  const [d, setD] = useState(initial);
  const parsed = Object.fromEntries(Object.entries(d).map(([k, t]) => [k, parseBar(t)]));
  const valid = Object.values(parsed).every((n) => n !== undefined);
  return (
    <SettingSection
      id="bars"
      title="Difficulty bars"
      meaning="How capable a model must be, as a percentile of the indexed models, for each difficulty of lane."
      issues={issuesAt(issues, "bars")}
      dirty={changed(d, initial)}
      valid={valid}
      disabled={disabled}
      onReview={() => propose(patchFor("bars", parsed as Record<string, number>))}
    >
      <div className="flex flex-wrap gap-4">
        {Object.keys(d).map((k) => (
          <NumberText
            key={k}
            label={k}
            unit="percentile, 0 to 100"
            value={d[k] ?? ""}
            invalid={parsed[k] === undefined ? "Enter a number from 0 to 100." : undefined}
            disabled={disabled}
            onChange={(v) => setD({ ...d, [k]: v })}
          />
        ))}
      </div>
    </SettingSection>
  );
}

function LimitsSection({ value, issues, propose, disabled }: SectionProps<Settings>) {
  const initial = {
    heavy: String(value.heavy),
    reserve: String(value.memory.reserveMb),
    per: String(value.memory.perMilestoneMb),
    floor: String(value.memory.floorMb),
  };
  const [d, setD] = useState(initial);
  const heavy = d.heavy.trim() === "cpus/2" ? "cpus/2" : parseAmount(d.heavy);
  const heavyOk = heavy === "cpus/2" || (typeof heavy === "number" && Number.isInteger(heavy));
  const reserve = parseAmount(d.reserve);
  const per = parseAmount(d.per);
  const floor = parseAmount(d.floor);
  const msg = "Enter a number above zero.";
  return (
    <SettingSection
      id="limits"
      title="Heavy lock and memory"
      meaning="How many heavy checks run at once, and the memory kept free when milestones start side by side."
      issues={issuesAt(issues, "limits")}
      dirty={changed(d, initial)}
      valid={heavyOk && reserve !== undefined && per !== undefined && floor !== undefined}
      disabled={disabled}
      onReview={() =>
        propose(
          patchFor("limits", {
            heavy: heavy as number | "cpus/2",
            reserveMb: reserve ?? null,
            perMilestoneMb: per ?? null,
            floorMb: floor ?? null,
          }),
        )
      }
    >
      <div className="flex flex-wrap gap-4">
        <NumberText
          label="Heavy checks"
          unit="at once, or cpus/2"
          value={d.heavy}
          invalid={heavyOk ? undefined : "Enter a whole number or cpus/2."}
          disabled={disabled}
          onChange={(v) => setD({ ...d, heavy: v })}
        />
        <NumberText
          label="Reserve"
          unit="MB kept free"
          value={d.reserve}
          invalid={reserve === undefined ? msg : undefined}
          disabled={disabled}
          onChange={(v) => setD({ ...d, reserve: v })}
        />
        <NumberText
          label="Per milestone"
          unit="MB each needs"
          value={d.per}
          invalid={per === undefined ? msg : undefined}
          disabled={disabled}
          onChange={(v) => setD({ ...d, per: v })}
        />
        <NumberText
          label="Floor"
          unit="MB at the least"
          value={d.floor}
          invalid={floor === undefined ? msg : undefined}
          disabled={disabled}
          onChange={(v) => setD({ ...d, floor: v })}
        />
      </div>
    </SettingSection>
  );
}

function PreflightSection({ value, issues, propose, disabled }: SectionProps<boolean>) {
  const [draft, setDraft] = useState(value);
  return (
    <SettingSection
      id="preflight"
      title="Preflight confirm"
      meaning="Park a run after its preflight check so you can confirm it before any worker starts."
      issues={issuesAt(issues, "preflight")}
      dirty={draft !== value}
      disabled={disabled}
      onReview={() => propose(patchFor("preflight", { confirm: draft }))}
    >
      <Switch isSelected={draft} onChange={setDraft} isDisabled={disabled}>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Switch.Content>
          <Label>Ask me to confirm the preflight</Label>
        </Switch.Content>
      </Switch>
    </SettingSection>
  );
}

function NotificationsSection({
  value,
  url,
  issues,
  propose,
  disabled,
}: SectionProps<Settings["notify"]> & { url: string | null }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string[]>(value);
  const [address, setAddress] = useState(url ?? "");
  const save = useMutation({
    ...setNotifyUrlMutation(),
    onSuccess: async () => {
      toast.success("Saved.");
      await invalidateOps(qc, "getSetup");
    },
    onError: (e) => toast.danger(errorMessage(e)),
  });
  return (
    <SettingSection
      id="notifications"
      title="Notifications"
      meaning="Which moments of a run send a notification, and the address they go to."
      issues={issuesAt(issues, "notifications")}
      dirty={changed([...draft].sort(), [...value].sort())}
      disabled={disabled}
      onReview={() => propose(patchFor("notifications", { notify: draft as Settings["notify"] }))}
    >
      <CheckboxGroup aria-label="Notify when" value={draft} onChange={setDraft} isDisabled={disabled}>
        {MOMENTS.map((m) => (
          <Checkbox key={m.id} value={m.id}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              {m.label}
            </Checkbox.Content>
          </Checkbox>
        ))}
      </CheckboxGroup>
      <div className="flex flex-wrap items-end gap-2">
        <TextField value={address} onChange={setAddress} isDisabled={disabled} className="min-w-56 flex-1">
          <Label>Notification address</Label>
          <Input placeholder="https://" />
        </TextField>
        <Button
          size="sm"
          variant="secondary"
          isPending={save.isPending}
          isDisabled={disabled || address.trim() === "" || address.trim() === (url ?? "")}
          onPress={() => save.mutate({ body: { url: address.trim() } })}
        >
          Save address
        </Button>
      </div>
    </SettingSection>
  );
}

function BillingSection({ value, issues, propose, disabled }: SectionProps<Settings["billing"]>) {
  const [draft, setDraft] = useState(value);
  return (
    <SettingSection
      id="billing"
      title="Billing"
      meaning="How each backend is paid for, which decides what a rung costs when catherd routes."
      issues={issuesAt(issues, "billing")}
      dirty={changed(draft, value)}
      disabled={disabled}
      onReview={() => propose(patchFor("billing", draft))}
    >
      <div className="flex flex-col gap-3">
        {Object.entries(draft).map(([backend, mode]) => (
          <div key={backend} className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="flex w-32 items-center gap-2 text-[13px]">
              <ProviderIcon backend={backend} size="xs" />
              {backendName(backend)}
            </span>
            <Choice
              label={`Billing for ${backendName(backend)}`}
              value={mode}
              options={BILLING}
              disabled={disabled}
              onChange={(m) => setDraft({ ...draft, [backend]: m })}
            />
          </div>
        ))}
      </div>
    </SettingSection>
  );
}

function IsolationSection({ value, issues, propose, disabled }: SectionProps<Settings["isolated"]>) {
  const [draft, setDraft] = useState(value);
  return (
    <SettingSection
      id="isolation"
      title="Isolation"
      meaning="Run a backend's workers in a clean home instead of your own configuration, plugins and memory."
      issues={issuesAt(issues, "isolation")}
      dirty={changed(draft, value)}
      disabled={disabled}
      onReview={() => propose(patchFor("isolation", draft))}
    >
      <div className="flex flex-col gap-2">
        {Object.entries(draft).map(([backend, on]) => (
          <Switch
            key={backend}
            isSelected={on}
            isDisabled={disabled}
            onChange={(v) => setDraft({ ...draft, [backend]: v })}
          >
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Switch.Content>
              <Label>Isolate {backendName(backend)}</Label>
            </Switch.Content>
          </Switch>
        ))}
        {Object.keys(draft).length === 0 ? <p className="text-muted text-sm">No backend is listed.</p> : null}
      </div>
    </SettingSection>
  );
}
