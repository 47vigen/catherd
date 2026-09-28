import { useEffect, useRef, useState } from "react";
import { useApp, useBack, useNow } from "../providers/app.tsx";
import { useData, usePoll } from "../providers/data.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import { errorToast } from "../providers/toast.tsx";
import { useUi } from "../providers/theme.tsx";
import { isArmed } from "../state.ts";
import { ago, clock, plural, shortRung, wrap } from "../text.ts";
import { glyph, mascot, type Token } from "../theme.ts";
import type { RoleRow, SessionRow, SessionRun } from "../effects.ts";
import { Line, type Part } from "../widgets/line.tsx";
import { List, type ListItem, useSelected } from "../widgets/list.tsx";

/** How often an open screen is read again when its run folders cannot be watched, unless paused (spec §4). */
export const RUN_EVERY_MS = 1_000;
/** How often a watched screen is read again all the same: a run that joins the session has no watch yet. */
export const WATCHED_EVERY_MS = 5_000;

/**
 * The selected row, where moving the cursor takes back a first ctrl+d (Ruling 3: moving or esc disarms),
 * as the dialog list does.
 */
function useSelection(): [string | null, (key: string) => void, () => string | null] {
  const app = useApp();
  const sel = useSelected();
  const select = (key: string) => {
    if (key !== sel.current() && app.getState().armed) app.dispatch({ type: "disarm" });
    sel.select(key);
  };
  return [sel.selected, select, sel.current];
}

/** One session of the top level: `● live  <name>  2 runs · 3 live roles · 1 landed  4m ago` (spec §4). */
export function sessionParts(s: SessionRow, now: number, plain: boolean): Part[] {
  return [
    s.live
      ? { text: `${glyph("live", plain)} live  `, tone: "info" }
      : { text: `${glyph("dot", plain)} idle  `, tone: "muted" },
    { text: `${s.name}  `, bold: true },
    {
      text: `${plural(s.runs, "run")} · ${plural(s.liveRoles, "live role")} · ${s.landed} landed  `,
      tone: "muted",
    },
    { text: ago(now - Date.parse(s.lastActivity)), tone: "muted" },
  ];
}

const keyOf = (k: string | null) => (k === null ? "earlier" : `s:${k}`);
const fromKey = (k: string) => (k === "earlier" ? null : k.slice("s:".length));

function SessionList(props: { width: number; height: number }) {
  const app = useApp();
  const data = useData();
  const ui = useUi();
  const now = useNow(1_000);
  const [selected, setSelected, selectedNow] = useSelection();
  const rows = data.sessions.value?.rows ?? [];
  useCommandLayer("row.runs", {
    "runs.open": () => {
      const k = selectedNow();
      if (k) app.dispatch({ type: "session", key: fromKey(k) });
    },
  });
  const updated = app.state.paused
    ? "paused"
    : data.sessions.at !== null
      ? `updated ${ago(now - data.sessions.at)}`
      : "";
  const items: ListItem[] = rows.map((s) => ({
    key: keyOf(s.key),
    selectable: true,
    render: (sel, w) => (
      <Line width={w} selected={sel} parts={[{ text: " " }, ...sessionParts(s, now, ui.plain)]} />
    ),
  }));
  const warnings = data.sessions.value?.warnings ?? [];
  // a failed read says so, whether rows from an earlier good read are shown, none were, or none exist
  const failed = data.sessions.error;
  const failure = failed ? (
    <Line
      width={props.width}
      parts={[{ text: ` ${glyph("fail", ui.plain)} could not read the runs: ${failed}`, tone: "error" }]}
    />
  ) : null;
  if (rows.length === 0 && data.sessions.value) {
    const art = mascot("waiting");
    return (
      <box flexDirection="column" width={props.width} height={props.height} paddingTop={failed ? 1 : 2}>
        {failure}
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
          { text: " SESSIONS", bold: true },
          { text: `  ${updated}`, tone: app.state.paused ? "warning" : "muted" },
        ]}
      />
      {failure}
      <List
        items={items}
        selected={selected}
        onSelect={setSelected}
        width={props.width}
        height={props.height - 1 - (failed ? 1 : 0) - Math.min(2, warnings.length)}
        filter={null}
        empty={failed ? "no runs read yet" : "reading runs…"}
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

/** A finished role's glyph and colour by its record's status; a live one's by running or starting. */
function roleMark(r: RoleRow, plain: boolean): Part {
  if (r.live) return { text: glyph(r.status === "running" ? "live" : "waiting", plain), tone: "info" };
  const tone: Token =
    r.status === "ok"
      ? "success"
      : r.status === "cancelled"
        ? "muted"
        : r.status === "limit"
          ? "warning"
          : "error";
  return { text: glyph(r.status === "ok" ? "ok" : r.status === "cancelled" ? "skip" : "fail", plain), tone };
}

/** A run's heading on its session's screen: title, repo, when it started, its budget, where it moved. */
function runHeading(r: SessionRun, now: number, plain: boolean): Part[] {
  const bits = [r.repo, `started ${ago(now - Date.parse(r.createdAt))}`];
  if (r.budget !== null) bits.push(`budget ${Math.round(r.budget * 100)}%`);
  const moved =
    r.continued === "here" ? "continued here" : r.continuedIn ? `continued in ${r.continuedIn}` : null;
  return [
    { text: ` ${glyph("shut", plain)} ` },
    { text: r.title, bold: true },
    { text: `  ${bits.join(" · ")}`, tone: "muted" },
    ...(moved ? [{ text: ` · ${moved}`, tone: "info" as Token }] : []),
  ];
}

/** Spec §4: the open screen redraws when a run file changes, else every second; `p` stops both. */
function useLiveRead<T extends { dirs: string[] }>(read: () => T, key: string) {
  const app = useApp();
  const [watching, setWatching] = useState(false);
  const polled = usePoll(read, watching ? WATCHED_EVERY_MS : RUN_EVERY_MS, { paused: app.state.paused, key });
  const refresh = useRef(polled.refresh);
  refresh.current = polled.refresh;
  const dirs = polled.value?.dirs.join("\n") ?? "";
  useEffect(() => {
    if (app.state.paused || dirs === "") {
      setWatching(false);
      return;
    }
    const stop = app.effects.watch(dirs.split("\n"), () => refresh.current());
    setWatching(stop !== null);
    return () => stop?.();
  }, [dirs, app.state.paused, app.effects]);
  return { ...polled, watching };
}

function SessionView(props: { sessionKey: string | null; width: number; height: number }) {
  const app = useApp();
  const ui = useUi();
  const now = useNow(1_000);
  const [selected, setSelected, selectedNow] = useSelection();
  const polled = useLiveRead(() => app.effects.session(props.sessionKey), String(props.sessionKey));
  useBack(true, "view", () => app.dispatch({ type: "up" }));
  const d = polled.value;
  const roleAt = (key: string | null) =>
    d?.runs.flatMap((r) => r.roles).find((x) => key === `role:${x.run}:${x.dispatchId}`) ?? null;
  useCommandLayer("row.runs", {
    "runs.open": () => {
      const r = roleAt(selectedNow());
      if (r) app.dispatch({ type: "role", run: r.run, dispatchId: r.dispatchId });
    },
    "runs.cancel": () => {
      const r = roleAt(selectedNow());
      if (!r?.live) return;
      const target = `${r.run}/${r.name}`;
      const t = app.clock.now();
      if (!isArmed(app.getState(), "cancel", target, t))
        return app.dispatch({ type: "arm", what: "cancel", target, at: t });
      app.dispatch({ type: "disarm" });
      void app.effects.cancel(r.run, r.name).then(
        (msg) => {
          app.toast({ variant: "success", message: msg });
          polled.refresh();
        },
        (e: unknown) => app.toast(errorToast(e)),
      );
    },
  });
  if (!d)
    return (
      <Line
        width={props.width}
        parts={[
          {
            text: polled.error ? ` ${polled.error}` : " reading the session…",
            tone: polled.error ? "error" : "muted",
          },
        ]}
      />
    );
  const items: ListItem[] = [];
  const text = (key: string, parts: Part[]) =>
    items.push({ key, selectable: false, render: (_sel, w) => <Line width={w} parts={parts} /> });
  for (const r of d.runs) {
    text(`run:${r.id}`, runHeading(r, now, ui.plain));
    if (r.milestones.length)
      text(`ms:${r.id}`, [
        { text: "   " },
        ...r.milestones.flatMap((m, i): Part[] => [
          ...(i ? [{ text: "  " }] : []),
          m.landed
            ? { text: `${glyph("ok", ui.plain)} ${m.name}`, tone: "success" }
            : { text: `${glyph("waiting", ui.plain)} ${m.name}`, tone: "muted" },
          ...(m.what ? [{ text: ` ${m.what}`, tone: "muted" as Token }] : []),
        ]),
      ]);
    if (r.roles.length === 0) text(`none:${r.id}`, [{ text: "   no role has run yet", tone: "muted" }]);
    for (const x of r.roles) {
      const secs = x.live ? (now - Date.parse(x.since)) / 1000 : (x.secs ?? 0);
      const armed = isArmed(app.state, "cancel", `${x.run}/${x.name}`, app.clock.now());
      items.push({
        key: `role:${x.run}:${x.dispatchId}`,
        selectable: true,
        render: (sel, w) => (
          <Line
            width={w}
            selected={sel}
            parts={[
              { text: "   " },
              roleMark(x, ui.plain),
              { text: ` ${x.name.padEnd(15)} `, bold: true },
              { text: shortRung(x.rung).padEnd(19) },
              { text: x.status.padEnd(9), tone: x.live ? "info" : "muted" },
              { text: clock(secs).padEnd(7) },
              armed
                ? { text: "press ctrl+d again to cancel", tone: "warning" }
                : { text: x.lastEvent ?? "", tone: "muted" },
            ]}
          />
        ),
      });
    }
  }
  const s = d.session;
  const updated = app.state.paused ? "paused" : polled.at !== null ? `updated ${ago(now - polled.at)}` : "";
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <Line
        width={props.width}
        parts={[
          { text: ` ${s.name}  `, bold: true },
          s.live
            ? { text: `${glyph("live", ui.plain)} live`, tone: "info" }
            : { text: `${glyph("dot", ui.plain)} idle`, tone: "muted" },
          { text: ` · ${plural(s.runs, "run")} · ${plural(s.liveRoles, "live role")} · `, tone: "muted" },
          { text: updated, tone: app.state.paused ? "warning" : "muted" },
          {
            text: polled.error ? ` · ${glyph("fail", ui.plain)} could not read it: ${polled.error}` : "",
            tone: "error",
          },
        ]}
      />
      <List
        items={items}
        selected={selected}
        onSelect={setSelected}
        width={props.width}
        height={props.height - 1}
        filter={null}
        empty=""
      />
    </box>
  );
}

function RoleView(props: { run: string; dispatchId: string; width: number; height: number }) {
  const app = useApp();
  const ui = useUi();
  const [selected, setSelected] = useSelection();
  const polled = usePoll(() => app.effects.role(props.run, props.dispatchId), RUN_EVERY_MS, {
    paused: app.state.paused,
    key: `${props.run}/${props.dispatchId}`,
  });
  useBack(true, "view", () => app.dispatch({ type: "up" }));
  const d = polled.value;
  if (!d)
    return (
      <Line
        width={props.width}
        parts={[
          {
            text: polled.error ? ` ${polled.error}` : " reading the role…",
            tone: polled.error ? "error" : "muted",
          },
        ]}
      />
    );
  const items: ListItem[] = [];
  const room = Math.max(10, props.width - 4);
  let n = 0;
  const line = (parts: Part[]) =>
    items.push({
      key: `l${n++}`,
      selectable: true,
      render: (sel, w) => <Line width={w} selected={sel} parts={parts} />,
    });
  const section = (title: string, body: string, none: string) => {
    line([{ text: ` ${title}`, bold: true }]);
    const lines = body.trimEnd() ? body.trimEnd().split("\n") : [];
    if (lines.length === 0) line([{ text: `   ${none}`, tone: "muted" }]);
    for (const l of lines) for (const w of wrap(l, room)) line([{ text: `   ${w}` }]);
  };
  section("BRIEF", d.brief, "no brief");
  section("REPLY", d.reply, d.state === "finished" ? "no reply" : "no reply yet: the role is running");
  line([{ text: " RECORD", bold: true }]);
  const r = d.record;
  if (!r) line([{ text: "   none yet: the role is running", tone: "muted" }]);
  else {
    const k = (x: number) => `${Math.round(x / 1000)}k`;
    line([
      { text: `   ${r.status}`, tone: r.status === "ok" ? "success" : "error" },
      {
        text: r.replyStatus
          ? ` · STATUS ${r.replyStatus}${r.replyWhy ? ` — ${r.replyWhy}` : ""}`
          : " · no STATUS",
      },
    ]);
    line([
      {
        text: `   ${clock(r.secs)} · ${k(r.tokens.input)} in (${k(r.tokens.cached)} cached) · ${k(r.tokens.output)} out`,
        tone: "muted",
      },
    ]);
    line([{ text: `   changed ${r.changedOwned.join(", ") || "nothing it owns"}`, tone: "muted" }]);
    if (r.violations.length)
      line([{ text: `   outside its lane: ${r.violations.join(", ")}`, tone: "warning" }]);
    if (r.thread) line([{ text: `   thread ${r.thread}`, tone: "muted" }]);
  }
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <Line
        width={props.width}
        parts={[
          { text: ` ${d.name}`, bold: true },
          {
            text: ` ${d.role} · ${shortRung(d.rung)} · ${r?.status ?? d.state} · ${d.runTitle}`,
            tone: "muted",
          },
          {
            text: polled.error ? ` · ${glyph("fail", ui.plain)} could not read it: ${polled.error}` : "",
            tone: "error",
          },
        ]}
      />
      <List
        items={items}
        selected={selected}
        onSelect={setSelected}
        width={props.width}
        height={props.height - 1}
        filter={null}
        empty=""
      />
    </box>
  );
}

/**
 * Spec §4 (tab 3): the sessions, newest activity first; enter opens a session (its runs, milestones and roles,
 * live ones first), enter on a role opens it (brief, reply, record); esc goes back one level; p pauses.
 */
export function RunsView(props: { width: number; height: number }) {
  const app = useApp();
  const data = useData();
  useCommandLayer("tab.runs", {
    "runs.refresh": () => data.sessions.refresh(),
    "runs.pause": () => {
      app.dispatch({ type: "pause" });
      app.toast({ variant: "info", message: app.getState().paused ? "Updates paused" : "Updates resumed" });
    },
  });
  const { role, session } = app.state;
  if (role)
    return <RoleView run={role.run} dispatchId={role.dispatchId} width={props.width} height={props.height} />;
  if (session) return <SessionView sessionKey={session.key} width={props.width} height={props.height} />;
  return <SessionList width={props.width} height={props.height} />;
}
