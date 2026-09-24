import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useState } from "react";
import type { HarnessCost } from "../core/harness.ts";
import { entryFor, saveTreatLike } from "../routing/catalog.ts";
import { type Backend, type Catalog, type Profile, type RungId, rungOf } from "../types.ts";
import type { BackendStatus } from "./backends.ts";
import {
  type BudgetField,
  failoverOptions,
  isTicked,
  openKey,
  readySet,
  type Row,
  rowId,
  rows as buildRows,
  ticked,
  toggle,
  treatLikeOptions,
} from "./matrix-model.ts";
import { costNote, glyph, HARNESS_HINT, shortRung, tint, type Ui } from "./theme.ts";

export interface MatrixProps {
  ui: Ui;
  profile: Profile;
  catalog: Catalog;
  backends: BackendStatus[];
  costs?: HarnessCost[];
  reloadCatalog: () => Catalog;
  onChange: (p: Profile) => void;
  onCatalog: (c: Catalog) => void;
  onSubmit: () => void;
  onQuit: () => void;
  onKey?: (input: string) => void;
  active?: boolean;
  height?: number;
  submitLabel?: string;
}

type EffortRow = Extract<Row, { kind: "effort" }>;
type Mode =
  | "nav"
  | "filter"
  | { row: EffortRow; rung: RungId }
  | { failover: RungId }
  | { budgetField: BudgetField; buffer: string };

export function Matrix(props: MatrixProps) {
  const {
    ui,
    profile,
    catalog,
    backends,
    costs = [],
    active = true,
    height = 14,
    submitLabel = "save",
  } = props;
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<Mode>("nav");
  const [note, setNote] = useState("");
  const ready = readySet(backends);
  const list = buildRows(profile, catalog, open, filter);
  const at = Math.min(cursor, list.length - 1);
  const here = list[at];
  const pink = tint("pink", ui.depth);
  const dot = ` ${glyph("dot", ui.plain)} `;

  const apply = (row: Row, c: Catalog) => {
    const t = toggle(profile, c, row, ready);
    if ("profile" in t) {
      props.onChange(t.profile);
      setNote("");
    } else if ("refused" in t) {
      setNote(t.refused);
    } else if (row.kind === "effort") {
      if (treatLikeOptions(c, row.role).length === 0)
        setNote(`No scored rung can stand in for ${t.needsTreatLike}.`);
      else setMode({ row, rung: t.needsTreatLike });
    }
  };

  const collapse = (row: Row) => {
    const own = openKey(row);
    const key =
      row.kind === "backend" || row.kind === "harness" || (row.kind === "model" && !open.has(own ?? ""))
        ? `role:${row.role}`
        : own;
    if (!key) return;
    const next = new Set(open);
    next.delete(key);
    setOpen(next);
    const idx = buildRows(profile, catalog, next, filter).findIndex(
      (r) => (r.kind === "role" || r.kind === "model") && openKey(r) === key,
    );
    setCursor(Math.max(0, idx));
  };

  useKeyboard((key) => {
    if (!active || !here) return;
    if (typeof mode !== "string") {
      if (key.name === "escape") {
        setMode("nav");
        return;
      }
      if ("budgetField" in mode) {
        if (key.name === "return") {
          const n = mode.buffer === "" ? undefined : Number(mode.buffer);
          const next = structuredClone(profile);
          const budget = { ...next.budget };
          // ponytail: "1.2.3" parses to NaN and clears the cap rather than rejecting the keystroke;
          // the digit/"." filter below already keeps the common case sane.
          if (n === undefined || Number.isNaN(n)) delete budget[mode.budgetField];
          else budget[mode.budgetField] = n;
          next.budget = Object.keys(budget).length > 0 ? budget : undefined;
          props.onChange(next);
          setMode("nav");
        } else if (key.name === "backspace") {
          setMode({ ...mode, buffer: mode.buffer.slice(0, -1) });
        } else if (key.sequence && /^[0-9.]$/.test(key.sequence)) {
          setMode({ ...mode, buffer: mode.buffer + key.sequence });
        }
      }
      return;
    }
    if (mode === "filter") {
      if (key.name === "escape") {
        setFilter("");
        setMode("nav");
      } else if (key.name === "return") setMode("nav");
      else if (key.name === "backspace") setFilter((f) => f.slice(0, -1));
      else if (!key.ctrl && !key.meta) {
        const ch = key.name === "space" ? " " : key.sequence;
        // Typed text can arrive as several keypress events inside one JS tick, before this
        // component re-renders, so the update must build on the queued value, not the closure's.
        if (ch && ch.length === 1) {
          setFilter((f) => f + ch);
          setCursor(0);
        }
      }
      return;
    }
    if (key.name === "up") setCursor(Math.max(0, at - 1));
    else if (key.name === "down") setCursor(Math.min(list.length - 1, at + 1));
    else if (key.name === "right") {
      const k = here.kind === "role" || here.kind === "model" ? openKey(here) : null;
      if (k) setOpen(new Set(open).add(k));
    } else if (key.name === "left") collapse(here);
    else if (key.name === "return") props.onSubmit();
    else if (key.name === "space") {
      if (here.kind === "model" && !isTicked(profile, here))
        setOpen(new Set(open).add(`model:${here.role}:${here.model.id}`));
      else if (here.kind === "budget")
        setMode({ budgetField: here.field, buffer: String(profile.budget?.[here.field] ?? "") });
      else if (here.kind === "failover") setMode({ failover: here.rung });
      else apply(here, catalog);
    } else if (key.sequence === "/") setMode("filter");
    else if (key.sequence === "q") props.onQuit();
    else if (key.sequence) props.onKey?.(key.sequence);
  });

  if (typeof mode !== "string" && "budgetField" in mode) {
    return (
      <box style={{ flexDirection: "column" }}>
        <text wrapMode="none" truncate>{`${mode.budgetField}: ${mode.buffer}_`}</text>
        <text attributes={TextAttributes.DIM}>
          {`digits set the cap${dot}backspace edits${dot}enter saves${dot}esc cancels${dot}empty clears it`}
        </text>
      </box>
    );
  }

  if (typeof mode !== "string" && "failover" in mode) {
    return (
      <box style={{ flexDirection: "column" }}>
        <text wrapMode="none" truncate>
          {`Stand-in for ${mode.failover} on a quota limit:`}
        </text>
        <select
          focused
          showDescription={false}
          style={{ height: 8 }}
          options={[
            { name: "(none)", description: "", value: "" },
            ...failoverOptions(catalog, mode.failover).map((r) => ({ name: r, description: "", value: r })),
          ]}
          onSelect={(_, option) => {
            if (!option) return;
            const next = structuredClone(profile);
            const failover = { ...next.failover };
            if (option.value) failover[mode.failover] = option.value as RungId;
            else delete failover[mode.failover];
            next.failover = Object.keys(failover).length > 0 ? failover : undefined;
            props.onChange(next);
            setMode("nav");
          }}
        />
        <text attributes={TextAttributes.DIM}>{`enter picks${dot}esc cancels`}</text>
      </box>
    );
  }

  if (typeof mode !== "string") {
    return (
      <box style={{ flexDirection: "column" }}>
        <text wrapMode="none" truncate>
          {`${mode.rung} has no scores yet. Treat it like which scored rung?`}
        </text>
        <select
          focused
          showDescription={false}
          style={{ height: 8 }}
          options={treatLikeOptions(catalog, mode.row.role).map((r) => ({
            name: r,
            description: "",
            value: r,
          }))}
          onSelect={(_, option) => {
            if (!option) return;
            const like = option.value as RungId;
            saveTreatLike(mode.rung, like);
            const c = props.reloadCatalog();
            props.onCatalog(c);
            setMode("nav");
            apply(mode.row, c);
          }}
        />
        <text attributes={TextAttributes.DIM}>{`enter picks${dot}esc cancels`}</text>
      </box>
    );
  }

  const notReady = new Map<Backend, string>(
    backends.filter((b) => !(b.installed && b.loggedIn)).map((b) => [b.backend, b.fix ?? ""]),
  );
  const box = (on: boolean) => glyph(on ? "on" : "off", ui.plain);
  const fold = (k: string) =>
    glyph(open.has(k) || (filter !== "" && k.startsWith("role:")) ? "open" : "shut", ui.plain);

  const describe = (r: Row): { text: string; dim: boolean; tag: string | null } => {
    switch (r.kind) {
      case "role": {
        const on = profile.roles[r.role].enabled;
        const rungs = ticked(profile, r.role).map(shortRung).join(", ") || "nothing ticked";
        return {
          text: `${fold(`role:${r.role}`)} ${box(on)} ${r.role.padEnd(12)}${on ? rungs : "off"}`,
          dim: !on,
          tag: null,
        };
      }
      case "backend": {
        const fix = notReady.get(r.backend);
        return {
          text: `    ${r.backend}`,
          dim: fix !== undefined,
          tag: fix === undefined ? null : `not ready${dot}${fix}`,
        };
      }
      case "harness": {
        const iso = profile.harness[r.backend].isolated;
        const cost = costs.find((h) => h.backend === r.backend);
        const sw = `${iso ? "native" : "[native]"} ${glyph("swap", ui.plain)} ${iso ? "[isolated]" : "isolated"}`;
        return { text: `      ${r.backend}: ${sw}`, dim: false, tag: cost ? costNote(cost) || null : null };
      }
      case "model": {
        const efforts = profile.roles[r.role].models[r.model.id] ?? [];
        return {
          text: `      ${fold(`model:${r.role}:${r.model.id}`)} ${box(efforts.length > 0)} ${r.model.id}  ${efforts.join(" ")}`,
          dim: !ready.has(r.model.backend),
          tag: null,
        };
      }
      case "effort": {
        const rung = rungOf(r.model.id, r.effort);
        const like = catalog.treatLike[rung];
        return {
          text: `          ${box(isTicked(profile, r))} ${r.effort}`,
          dim: !ready.has(r.model.backend),
          tag: like ? `like ${shortRung(like)}` : entryFor(catalog, rung) ? null : "unscored",
        };
      }
      case "objective":
        return {
          text: `objective     ${profile.objective}  (${profile.objective === "cost" ? "cheapest rung first" : "fastest rung first"})`,
          dim: false,
          tag: null,
        };
      case "lock":
        return { text: `heavy slots   ${profile.lock.heavy}  (for catherd lock)`, dim: false, tag: null };
      case "budget": {
        const v = profile.budget?.[r.field];
        return {
          text: `${`budget ${r.field}`.padEnd(16)}${v === undefined ? "no cap" : v}`,
          dim: false,
          tag: null,
        };
      }
      case "failover": {
        const to = profile.failover?.[r.rung];
        return {
          text: `${`failover ${shortRung(r.rung)}`.padEnd(28)}${to ? `${glyph("arrow", ui.plain)} ${shortRung(to)}` : "no stand-in"}`,
          dim: false,
          tag: null,
        };
      }
      case "notify":
        return {
          text: `${box(profile.notify.includes(r.moment))} notify on ${r.moment}`,
          dim: false,
          tag: null,
        };
    }
  };

  const start = Math.max(0, Math.min(at - Math.floor(height / 2), list.length - height));
  return (
    <box style={{ flexDirection: "column" }}>
      {list.slice(start, start + height).map((r, i) => {
        const cur = start + i === at;
        const { text, dim, tag } = describe(r);
        const attrs = (cur ? TextAttributes.BOLD : 0) | (dim && !cur ? TextAttributes.DIM : 0);
        return (
          <text key={rowId(r)} wrapMode="none" truncate attributes={attrs}>
            <span fg={pink}>{cur ? glyph("cursor", ui.plain) : " "}</span>
            {` ${text}`}
            {tag ? <span fg={pink}>{` ${tag}`}</span> : null}
          </text>
        );
      })}
      {here?.kind === "harness" ? (
        <text attributes={TextAttributes.DIM} wrapMode="none" truncate>
          {HARNESS_HINT[here.backend]}
        </text>
      ) : null}
      <text attributes={TextAttributes.DIM} wrapMode="none" truncate>
        {mode === "filter"
          ? `filter: ${filter}_${dot}enter keeps it${dot}esc clears it`
          : `${glyph("keys", ui.plain)} move${dot}${glyph("arrow", ui.plain)} open${dot}space ticks${dot}/ filter${dot}enter ${submitLabel}${dot}q quit`}
      </text>
      {filter && mode === "nav" ? <text attributes={TextAttributes.DIM}>{`filter: ${filter}`}</text> : null}
      {note ? (
        <text fg={pink} wrapMode="none" truncate>
          {note}
        </text>
      ) : null}
    </box>
  );
}
