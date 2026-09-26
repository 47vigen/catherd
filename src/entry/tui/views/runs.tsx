import { useState } from "react";
import { useApp, useBack, useNow } from "../providers/app.tsx";
import { usePoll, useData } from "../providers/data.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import { useUi } from "../providers/theme.tsx";
import { isArmed } from "../state.ts";
import { ago, clock, shortRung } from "../text.ts";
import { glyph, mascot, type Token } from "../theme.ts";
import { Line, type Part } from "../widgets/line.tsx";
import { List, type ListItem } from "../widgets/list.tsx";
import type { RunDetail } from "../effects.ts";
import { runParts } from "./status.tsx";

/** How often an open run is read again, unless paused. */
export const RUN_EVERY_MS = 1_000;

/** `[██████░░░░] 52% · 31/60 min`, green below 80 %, amber below 100 %, red at 100 % (spec §4.6). */
export function budgetParts(d: RunDetail, width: number, plain: boolean): Part[] {
  const b = d.summary.budget;
  if (!b) return [{ text: "no budget cap", tone: "muted" }];
  const cells = Math.max(10, Math.min(30, width - 40));
  const full = Math.min(cells, Math.round(b.fraction * cells));
  const tone: Token = b.fraction >= 1 ? "error" : b.fraction >= 0.8 ? "warning" : "success";
  const caps = [
    b.minutes ? `${Math.round(b.minutes.spent)}/${b.minutes.cap} min` : "",
    b.tokens ? `${b.tokens.spent}/${b.tokens.cap} tokens` : "",
    b.usd ? `$${b.usd.spent.toFixed(2)}/$${b.usd.cap.toFixed(2)}` : "",
  ].filter(Boolean);
  return [
    { text: "[" },
    { text: glyph("full", plain).repeat(full), tone },
    { text: glyph("empty", plain).repeat(cells - full), tone: "muted" },
    { text: `] ${Math.round(b.fraction * 100)}%`, tone },
    { text: ` · ${caps.join(" · ")}`, tone: "muted" },
  ];
}

/**
 * The selected row, where moving the cursor takes back a first ctrl+d (Ruling 3: moving or esc disarms),
 * as the dialog list does.
 */
function useSelection(): [string | null, (key: string) => void] {
  const app = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const select = (key: string) => {
    if (key !== selected && app.getState().armed) app.dispatch({ type: "disarm" });
    setSelected(key);
  };
  return [selected, select];
}

function RunList(props: { width: number; height: number }) {
  const app = useApp();
  const data = useData();
  const ui = useUi();
  const now = useNow(1_000);
  const [selected, setSelected] = useSelection();
  const rows = data.runs.value?.rows ?? [];
  useCommandLayer("row.runs", {
    "runs.open": () => selected && app.dispatch({ type: "run", id: selected }),
  });
  const updated = app.state.paused
    ? "paused"
    : data.runs.at !== null
      ? `updated ${ago(now - data.runs.at)}`
      : "";
  const items: ListItem[] = rows.map((r) => ({
    key: r.id,
    selectable: true,
    render: (sel, w) => (
      <Line width={w} selected={sel} parts={[{ text: " " }, ...runParts(r, now, ui.plain)]} />
    ),
  }));
  const warnings = data.runs.value?.warnings ?? [];
  if (rows.length === 0 && data.runs.value) {
    const art = mascot("waiting");
    return (
      <box flexDirection="column" width={props.width} height={props.height} paddingTop={2}>
        {art.map((l) => (
          <Line key={l} width={props.width} parts={[{ text: `   ${l}`, tone: "muted" }]} />
        ))}
        <Line
          width={props.width}
          parts={[
            { text: "   No runs yet. Start one in Claude Code: /catherd <what to build>", tone: "muted" },
          ]}
        />
      </box>
    );
  }
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <Line
        width={props.width}
        parts={[
          { text: " RUNS", bold: true },
          { text: `  ${updated}`, tone: app.state.paused ? "warning" : "muted" },
        ]}
      />
      <List
        items={items}
        selected={selected}
        onSelect={setSelected}
        width={props.width}
        height={props.height - 1 - Math.min(2, warnings.length)}
        filter={null}
        empty="reading runs…"
      />
      {warnings.slice(0, 2).map((w) => (
        <Line
          key={w}
          width={props.width}
          parts={[{ text: ` ${glyph("warn", ui.plain)} ${w}`, tone: "warning" }]}
        />
      ))}
    </box>
  );
}

function RunView(props: { id: string; width: number; height: number }) {
  const app = useApp();
  const ui = useUi();
  const now = useNow(1_000);
  const [selected, setSelected] = useSelection();
  const polled = usePoll(() => app.effects.run(props.id), RUN_EVERY_MS, {
    paused: app.state.paused,
    key: props.id,
  });
  useBack(true, "view", () => app.dispatch({ type: "run", id: null }));
  const d = polled.value;
  const lane = selected?.startsWith("lane:") ? selected.slice("lane:".length) : null;
  useCommandLayer("row.runs", {
    "runs.cancel": () => {
      if (!lane) return;
      const t = app.clock.now();
      if (!isArmed(app.getState(), "cancel", lane, t))
        return app.dispatch({ type: "arm", what: "cancel", target: lane, at: t });
      app.dispatch({ type: "disarm" });
      void app.effects.cancel(props.id, lane).then(
        (msg) => {
          app.toast({ variant: "success", message: msg });
          polled.refresh();
        },
        (e: unknown) => app.toast({ variant: "error", message: e instanceof Error ? e.message : String(e) }),
      );
    },
  });
  if (!d)
    return (
      <Line
        width={props.width}
        parts={[
          {
            text: polled.error ? ` ${polled.error}` : " reading the run…",
            tone: polled.error ? "error" : "muted",
          },
        ]}
      />
    );
  const s = d.summary;
  const items: ListItem[] = [];
  const text = (key: string, parts: Part[]) =>
    items.push({ key, selectable: false, render: (_sel, w) => <Line width={w} parts={parts} /> });
  const heading = (key: string, label: string) => text(key, [{ text: ` ${label}`, bold: true }]);
  heading("h:live", "LIVE");
  if (s.live.length === 0) text("live:none", [{ text: "   no role is running", tone: "muted" }]);
  for (const l of s.live) {
    const armed = isArmed(app.state, "cancel", l.name, app.clock.now());
    items.push({
      key: `lane:${l.name}`,
      selectable: true,
      render: (sel, w) => (
        <Line
          width={w}
          selected={sel}
          parts={[
            { text: `   ${glyph(l.state === "running" ? "live" : "waiting", ui.plain)} `, tone: "info" },
            { text: l.name.padEnd(16), bold: true },
            { text: shortRung(l.rung).padEnd(20) },
            { text: clock(l.secs).padEnd(8) },
            armed
              ? { text: "press ctrl+d again to cancel", tone: "warning" }
              : { text: l.state, tone: "muted" },
          ]}
        />
      ),
    });
  }
  if (d.climbs.length) heading("h:climbs", "CLIMBS");
  d.climbs.forEach((c, i) =>
    text(`climb:${i}`, [
      { text: `   ${c.lane.padEnd(8)} ` },
      { text: `${shortRung(c.from)} ${glyph("arrow", ui.plain)} ${shortRung(c.to)}` },
      { text: `  ${c.reason}${c.env ? " (environment)" : ""}`, tone: "muted" },
    ]),
  );
  if (d.decisions.length) heading("h:routes", "ROUTES");
  d.decisions.forEach((r, i) =>
    text(`route:${i}`, [
      { text: `   ${r.lane.padEnd(8)} ${r.role.padEnd(10)}` },
      { text: `${r.source.padEnd(8)}`, tone: r.source === "jev" ? "info" : "muted" },
      { text: `${r.kind ?? "-"}/${r.difficulty ?? "-"}  `, tone: "muted" },
      { text: shortRung(r.rung) },
    ]),
  );
  if (s.milestones.length) heading("h:landed", "LANDED");
  s.milestones.forEach((m, i) =>
    text(`landed:${i}`, [{ text: `   ${glyph("ok", ui.plain)} `, tone: "success" }, { text: m }]),
  );
  if (s.stateTail.length) heading("h:next", "STATE");
  s.stateTail.forEach((l, i) => text(`state:${i}`, [{ text: `   ${l}`, tone: "muted" }]));
  const updated = app.state.paused ? "paused" : polled.at !== null ? `updated ${ago(now - polled.at)}` : "";
  const t = s.totals;
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <Line
        width={props.width}
        parts={[
          { text: ` ${s.title}`, bold: true },
          { text: `  ${s.repo} · started ${ago(now - Date.parse(s.createdAt))} · `, tone: "muted" },
          { text: updated, tone: app.state.paused ? "warning" : "muted" },
        ]}
      />
      <Line width={props.width} parts={[{ text: " budget " }, ...budgetParts(d, props.width, ui.plain)]} />
      <Line
        width={props.width}
        parts={[
          {
            text: ` ${t.runs} role runs, ${t.ok} ok · ${(t.tokens.input / 1000).toFixed(0)}k in · ${(t.tokens.output / 1000).toFixed(0)}k out · $${t.costUsd.toFixed(2)}`,
            tone: "muted",
          },
        ]}
      />
      <List
        items={items}
        selected={selected}
        onSelect={setSelected}
        width={props.width}
        height={props.height - 3}
        filter={null}
        empty=""
      />
    </box>
  );
}

/** Spec §9.1 tab 3: the run list; enter opens a run (live lanes, climbs, routes, budget, landed); p pauses. */
export function RunsView(props: { width: number; height: number }) {
  const app = useApp();
  const data = useData();
  useCommandLayer("tab.runs", {
    "runs.refresh": () => data.runs.refresh(),
    "runs.pause": () => {
      app.dispatch({ type: "pause" });
      app.toast({ variant: "info", message: app.getState().paused ? "Updates paused" : "Updates resumed" });
    },
  });
  return app.state.run ? (
    <RunView id={app.state.run} width={props.width} height={props.height} />
  ) : (
    <RunList width={props.width} height={props.height} />
  );
}
