import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { HarnessCost } from "../core/harness.ts";
import { entryFor, saveTreatLike } from "../routing/catalog.ts";
import { candidates } from "../routing/select.ts";
import { type Backend, type Catalog, type Profile, type RungId, rungOf } from "../types.ts";
import type { BackendStatus } from "./backends.ts";
import {
  budgetDetailRows,
  type BudgetField,
  budgetSummary,
  type DetailRow,
  failoverDetailRows,
  failoverOptions,
  failoverSummary,
  isTicked,
  openKey,
  readySet,
  type Row,
  rowId,
  roleDetailRows,
  sectionOf,
  toggle,
  topLevelRows,
  type TopRow,
  treatLikeOptions,
} from "./matrix-model.ts";
import { dot, glyph, harnessLine, nick, shortRung, tint, type Ui } from "./theme.ts";
import { DetailPane, ListLine } from "./ui.tsx";

export interface MatrixProps {
  ui: Ui;
  profile: Profile;
  catalog: Catalog;
  backends: BackendStatus[];
  costs?: HarnessCost[];
  errors?: string[];
  reloadCatalog: () => Catalog;
  onChange: (p: Profile) => void;
  onCatalog: (c: Catalog) => void;
  onSubmit: () => void;
  onQuit: () => void;
  onKey?: (input: string) => void;
  active?: boolean;
  /** Controlled "?" help toggle, so the caller's `Frame` can render the hint bar it computes
   * with `matrixHint` outside the panel border instead of Matrix drawing its own. */
  onToggleHelp?: () => void;
}

/** The hint bar text for a Matrix at the given help state — exported so the caller's `Frame`
 * can render it outside the panel border while Matrix owns none of the layout itself. */
export function matrixHint(ui: Ui, submitLabel: string, showHelp: boolean, extraHint = ""): string {
  const dotSep = ` ${glyph("dot", ui.plain)} `;
  return showHelp
    ? `/ filter${dotSep}${extraHint}`
    : `${glyph("keys", ui.plain)} navigate${dotSep}${glyph("arrow", ui.plain)} open${dotSep}space ticks${dotSep}enter ${submitLabel}${dotSep}? more${dotSep}q quit`;
}

type EffortRow = Extract<DetailRow, { kind: "effort" }>;
type Mode =
  | "nav"
  | "filter"
  | { row: EffortRow; rung: RungId }
  | { failover: RungId }
  | { budgetField: BudgetField; buffer: string };

const LEFT_HEIGHT = 14;
const RIGHT_HEIGHT = 10;

/** "sol", "luna", "opus 5.5" — the short display name the right pane uses for a model id
 * (the full id still shows in the effort rows below it). */
export function shortModelName(id: string): string {
  const base = id.replace(/^.*\//, "").replace(/^gpt-\d+-/, "");
  return base === "claude-opus-5-5" ? "opus 5.5" : base;
}

export function Matrix(props: MatrixProps) {
  const { ui, profile, catalog, backends, costs = [], errors = [], active = true } = props;
  const [leftCursor, setLeftCursor] = useState(0);
  const [focus, setFocus] = useState<"left" | "right">("left");
  const [rightCursor, setRightCursor] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<Mode>("nav");
  const [note, setNote] = useState("");
  // "?" only does anything when the caller controls help (renders it outside the panel via
  // `matrixHint`) — Matrix itself draws no help text, so there is nothing to toggle otherwise.
  const toggleHelp = () => props.onToggleHelp?.();
  const ready = readySet(backends);
  const dotSep = ` ${glyph("dot", ui.plain)} `;

  const top = topLevelRows();
  const selTop = top[Math.min(leftCursor, top.length - 1)] as TopRow;
  const detail: DetailRow[] =
    selTop.kind === "role"
      ? roleDetailRows(profile, catalog, selTop.role, open, filter)
      : selTop.kind === "budget-summary"
        ? budgetDetailRows()
        : selTop.kind === "failover-summary"
          ? failoverDetailRows(profile, catalog)
          : [];
  const rightAt = Math.min(rightCursor, Math.max(0, detail.length - 1));
  const hereRight = detail[rightAt];

  const moveLeft = (idx: number) => {
    setLeftCursor(Math.max(0, Math.min(top.length - 1, idx)));
    setFocus("left");
    setRightCursor(0);
    setNote("");
  };

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

  const collapse = () => {
    const row = hereRight;
    const key = row && (row.kind === "model" || row.kind === "effort") ? openKey(row) : null;
    if (key && row && (row.kind === "effort" || open.has(key))) {
      const next = new Set(open);
      next.delete(key);
      setOpen(next);
      if (row.kind === "effort" && selTop.kind === "role") {
        const list = roleDetailRows(profile, catalog, selTop.role, next, filter);
        setRightCursor(
          Math.max(
            0,
            list.findIndex((r) => r.kind === "model" && openKey(r) === key),
          ),
        );
      }
      return;
    }
    setFocus("left");
  };

  useKeyboard((key) => {
    if (!active) return;
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
        if (ch && ch.length === 1) setFilter((f) => f + ch);
      }
      return;
    }
    if (key.name === "up") {
      if (focus === "left") moveLeft(leftCursor - 1);
      else setRightCursor(Math.max(0, rightAt - 1));
    } else if (key.name === "down") {
      if (focus === "left") moveLeft(leftCursor + 1);
      else setRightCursor(Math.min(Math.max(0, detail.length - 1), rightAt + 1));
    } else if (key.name === "right") {
      if (focus === "left") {
        if (detail.length > 0) {
          setFocus("right");
          setRightCursor(0);
        }
      } else if (hereRight?.kind === "model") {
        const k = openKey(hereRight);
        if (k) setOpen(new Set(open).add(k));
      }
    } else if (key.name === "left") {
      if (focus === "right") collapse();
    } else if (key.name === "return") props.onSubmit();
    else if (key.name === "space") {
      if (focus === "left") {
        if (selTop.kind === "budget-summary" || selTop.kind === "failover-summary") {
          setFocus("right");
          setRightCursor(0);
        } else apply(selTop, catalog);
      } else if (hereRight) {
        if (hereRight.kind === "model" && !isTicked(profile, hereRight)) {
          const k = openKey(hereRight);
          if (k) setOpen(new Set(open).add(k));
        } else if (hereRight.kind === "budget")
          setMode({ budgetField: hereRight.field, buffer: String(profile.budget?.[hereRight.field] ?? "") });
        else if (hereRight.kind === "failover") setMode({ failover: hereRight.rung });
        else apply(hereRight, catalog);
      }
    } else if (key.sequence === "/") setMode("filter");
    else if (key.sequence === "?") toggleHelp();
    else if (key.sequence === "q") props.onQuit();
    else if (key.sequence) props.onKey?.(key.sequence);
  });

  if (typeof mode !== "string" && "budgetField" in mode) {
    return (
      <box style={{ flexDirection: "column" }}>
        <text wrapMode="none" truncate>{`${mode.budgetField}: ${mode.buffer}_`}</text>
        <text attributes={TextAttributes.DIM}>
          {`digits set the cap${dotSep}backspace edits${dotSep}enter saves${dotSep}esc cancels${dotSep}empty clears it`}
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
        <text attributes={TextAttributes.DIM}>{`enter picks${dotSep}esc cancels`}</text>
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
        <text attributes={TextAttributes.DIM}>{`enter picks${dotSep}esc cancels`}</text>
      </box>
    );
  }

  const notReady = new Map<Backend, string>(
    backends.filter((b) => !(b.installed && b.loggedIn)).map((b) => [b.backend, b.fix ?? ""]),
  );

  // --- left pane -----------------------------------------------------------------------------
  const leftText = (r: TopRow): { text: string; dim: boolean; tag: string | null } => {
    switch (r.kind) {
      case "role": {
        const on = profile.roles[r.role].enabled;
        return {
          text: `${dot(on ? "ready" : "missing", ui.plain)} ${r.role}`,
          dim: !on,
          tag: on ? null : "off",
        };
      }
      case "objective":
        return { text: "objective", dim: false, tag: profile.objective };
      case "lock":
        return { text: "heavy slots", dim: false, tag: String(profile.lock.heavy) };
      case "harness":
        return {
          text: r.backend,
          dim: notReady.has(r.backend),
          tag: profile.harness[r.backend].isolated ? "isolated" : "native",
        };
      case "budget-summary":
        return { text: "budget", dim: false, tag: budgetSummary(profile, ` ${glyph("dot", ui.plain)} `) };
      case "failover-summary":
        return { text: "failover", dim: false, tag: failoverSummary(profile) };
      case "notify": {
        const on = profile.notify.includes(r.moment);
        return { text: `${dot(on ? "ready" : "missing", ui.plain)} ${r.moment}`, dim: !on, tag: null };
      }
    }
  };

  const start = Math.max(0, Math.min(leftCursor - Math.floor(LEFT_HEIGHT / 2), top.length - LEFT_HEIGHT));
  const leftWindow = top.slice(start, start + LEFT_HEIGHT);
  let lastSection = "";
  const leftLines = leftWindow.flatMap((r, i) => {
    const idx = start + i;
    const section = sectionOf(r);
    const heading =
      section !== lastSection ? (
        <text key={`h${section}`} fg={tint("pink", ui.depth)} attributes={TextAttributes.BOLD}>
          {section}
        </text>
      ) : null;
    lastSection = section;
    const { text, dim, tag } = leftText(r);
    return [
      heading,
      <ListLine
        key={rowId(r)}
        ui={ui}
        selected={idx === leftCursor && focus === "left"}
        dim={dim}
        text={text}
        tag={tag}
      />,
    ];
  });

  // --- right pane ------------------------------------------------------------------------------
  const dstart = Math.max(
    0,
    Math.min(rightAt - Math.floor(RIGHT_HEIGHT / 2), Math.max(0, detail.length - RIGHT_HEIGHT)),
  );
  const detailText = (r: DetailRow): { text: string; dim: boolean; tag: string | null } => {
    switch (r.kind) {
      case "backend": {
        const fix = notReady.get(r.backend as Backend);
        return {
          text: r.backend,
          dim: fix !== undefined,
          tag: fix === undefined ? null : `not ready${dotSep}${fix}`,
        };
      }
      case "model": {
        const efforts = profile.roles[r.role].models[r.model.id] ?? [];
        const on = efforts.length > 0;
        return {
          text: `${glyph(open.has(openKey(r) ?? "") ? "open" : "shut", ui.plain)} ${dot(on ? "ready" : "missing", ui.plain)} ${shortModelName(r.model.id)}  ${efforts.join(" ")}`.trimEnd(),
          dim: !ready.has(r.model.backend),
          tag: r.model.id,
        };
      }
      case "effort": {
        const rung = rungOf(r.model.id, r.effort);
        const like = catalog.treatLike[rung];
        return {
          text: `  ${dot(isTicked(profile, r) ? "ready" : "missing", ui.plain)} ${r.effort}`,
          dim: !ready.has(r.model.backend),
          tag: like ? `like ${shortRung(like)}` : entryFor(catalog, rung) ? null : "unscored",
        };
      }
      case "budget": {
        const v = profile.budget?.[r.field];
        return { text: r.field, dim: false, tag: v === undefined ? "no cap" : String(v) };
      }
      case "failover": {
        const to = profile.failover?.[r.rung];
        return {
          text: shortRung(r.rung),
          dim: false,
          tag: to ? `${glyph("arrow", ui.plain)} ${shortRung(to)}` : "no stand-in",
        };
      }
    }
  };

  const header = (): { title: string; subtitle: string } => {
    switch (selTop.kind) {
      case "role": {
        const on = profile.roles[selTop.role].enabled;
        return { title: selTop.role, subtitle: on ? "capable models and efforts" : "off" };
      }
      case "objective":
        return {
          title: "objective",
          subtitle: profile.objective === "cost" ? "cheapest rung first" : "fastest rung first",
        };
      case "lock":
        return { title: "heavy slots", subtitle: "how many roles catherd's lock treats as heavy" };
      case "harness":
        return { title: selTop.backend, subtitle: "vendor harness: native config or an isolated sandbox" };
      case "budget-summary":
        return { title: "budget", subtitle: "minutes, tokens and dollars this profile allows a run" };
      case "failover-summary":
        return { title: "failover", subtitle: "a stand-in rung for a codex/opencode quota limit" };
      case "notify":
        return { title: "notify", subtitle: "when catherd pings you" };
    }
  };

  const { title, subtitle } = header();
  const detailBody: ReactNode[] = [];
  if (selTop.kind === "harness") {
    const cost = costs.find((h) => h.backend === selTop.backend);
    detailBody.push(
      <text key="h" wrapMode="none" truncate>
        {harnessLine(selTop.backend, profile.harness[selTop.backend].isolated, cost, ui.plain)}
      </text>,
    );
  } else if (selTop.kind === "notify") {
    for (const m of ["milestone", "finish", "blocked"] as const) {
      const on = profile.notify.includes(m);
      detailBody.push(
        <text
          key={m}
          wrapMode="none"
          truncate
          attributes={m === selTop.moment ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {`${dot(on ? "ready" : "missing", ui.plain)} ${m}`}
        </text>,
      );
    }
  } else {
    detail.slice(dstart, dstart + RIGHT_HEIGHT).forEach((r, i) => {
      const idx = dstart + i;
      const { text, dim, tag } = detailText(r);
      detailBody.push(
        <ListLine
          key={rowId(r)}
          ui={ui}
          selected={focus === "right" && idx === rightAt}
          dim={dim}
          text={text}
          tag={tag}
        />,
      );
    });
    if (selTop.kind === "role") {
      const ladder = candidates(profile, catalog, selTop.role).map(
        (r) => nick(r) + " " + shortRung(r).split("#")[1],
      );
      if (ladder.length > 0)
        detailBody.push(
          <text key="ladder" attributes={TextAttributes.DIM} wrapMode="none" truncate>
            {`ladder ${dotSep}${ladder.join(` ${glyph("arrow", ui.plain)} `)}`}
          </text>,
        );
    }
  }

  return (
    <box style={{ flexDirection: "row" }}>
      <box style={{ flexDirection: "column", width: 22 }}>{leftLines}</box>
      <DetailPane ui={ui} title={title} subtitle={subtitle}>
        {detailBody}
        {note ? (
          <text fg={tint("pink", ui.depth)} wrapMode="none" truncate>
            {note}
          </text>
        ) : null}
        {mode === "filter" ? (
          <text attributes={TextAttributes.DIM} wrapMode="none" truncate>{`filter: ${filter}_`}</text>
        ) : filter ? (
          <text attributes={TextAttributes.DIM} wrapMode="none" truncate>{`filter: ${filter}`}</text>
        ) : null}
        {errors.map((e) => (
          <text key={e} fg={tint("pink", ui.depth)} wrapMode="none" truncate>
            {e}
          </text>
        ))}
      </DetailPane>
    </box>
  );
}
