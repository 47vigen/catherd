import { type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import { waitingLine } from "../../../services/orchestrator-wait.ts";
import { useApp, useBack, useNow } from "../providers/app.tsx";
import { useData, usePoll } from "../providers/data.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import { errorToast } from "../providers/toast.tsx";
import { useUi } from "../providers/theme.tsx";
import { isArmed } from "../state.ts";
import { ago, clock, plural, shortRung, wrap, wrapHanging } from "../text.ts";
import { glyph, mascot, type Token } from "../theme.ts";
import type { RoleRow, SessionDetail, SessionRow, SessionRun } from "../effects.ts";
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
function useSelection(
  initial: string | null = null,
): [string | null, (key: string) => void, () => string | null] {
  const app = useApp();
  const sel = useSelected(initial);
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
const roleKey = (run: string, dispatchId: string) => `role:${run}:${dispatchId}`;
const milestoneKey = (run: string, name: string) => `ms:${run}:${name}`;

/** What `r` re-reads: the open screen registers its read here (the command lives on the tab). */
type Refresher = MutableRefObject<(() => void) | null>;

/** Registers `refresh` as the open screen's while it is mounted. */
function useRefresher(refresher: Refresher, refresh: () => void) {
  // after every commit, and cleared only while still its own: the screen that replaces this one registers
  // after this one's cleanup has run
  useEffect(() => {
    refresher.current = refresh;
    return () => {
      if (refresher.current === refresh) refresher.current = null;
    };
  });
}

function SessionList(props: { width: number; height: number; initial: string | null }) {
  const app = useApp();
  const data = useData();
  const ui = useUi();
  const now = useNow(1_000);
  const [selected, setSelected, selectedNow] = useSelection(props.initial);
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
  const waiting = waitingLine(r.waiting, now);
  if (waiting) bits.push(waiting);
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
  // the watch calls the latest refresh; the ref moves after each commit, never during a render
  const refresh = useRef(polled.refresh);
  useEffect(() => {
    refresh.current = polled.refresh;
  });
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

/**
 * The row a session's screen starts on before the cursor moves: the first row of the run it was opened for,
 * else its first live role (live roles can sit below many landed milestones), else its first row.
 */
function startRow(d: SessionDetail, run: string | undefined): string | null {
  const rows = (r: SessionDetail["runs"][number]) => [
    ...r.milestones.map((m) => milestoneKey(r.id, m.name)),
    ...r.roles.map((x) => roleKey(x.run, x.dispatchId)),
  ];
  const asked = run === undefined ? undefined : d.runs.find((r) => r.id === run);
  const first = asked ? rows(asked)[0] : undefined;
  if (first) return first;
  const live = d.runs.flatMap((r) => r.roles).find((x) => x.live);
  if (live) return roleKey(live.run, live.dispatchId);
  return d.runs.flatMap(rows)[0] ?? null;
}

function SessionView(props: {
  sessionKey: string | null;
  run: string | undefined;
  width: number;
  height: number;
  initial: string | null;
  refresher: Refresher;
}) {
  const app = useApp();
  const ui = useUi();
  const now = useNow(1_000);
  const [chosen, setSelected, chosenNow] = useSelection(props.initial);
  const polled = useLiveRead(() => app.effects.session(props.sessionKey), String(props.sessionKey));
  useRefresher(props.refresher, polled.refresh);
  useBack(true, "view", () => app.dispatch({ type: "up" }));
  const d = polled.value;
  // each row's role or milestone by its key, built once per read rather than on every key
  const byKey = useMemo(() => {
    const roles = new Map<string, RoleRow>();
    const milestones = new Map<string, { run: string; name: string }>();
    for (const r of d?.runs ?? []) {
      for (const m of r.milestones) milestones.set(milestoneKey(r.id, m.name), { run: r.id, name: m.name });
      for (const x of r.roles) roles.set(roleKey(x.run, x.dispatchId), x);
    }
    return { roles, milestones, start: d ? startRow(d, props.run) : null };
  }, [d, props.run]);
  // until the cursor moves, it stands on the start row
  const selected = chosen ?? byKey.start;
  const selectedNow = () => chosenNow() ?? byKey.start;
  const roleAt = (key: string | null) => (key === null ? null : (byKey.roles.get(key) ?? null));
  const milestoneAt = (key: string | null) => (key === null ? null : (byKey.milestones.get(key) ?? null));
  useCommandLayer("row.runs", {
    "runs.open": () => {
      const k = selectedNow();
      const m = milestoneAt(k);
      if (m) return app.dispatch({ type: "milestone", run: m.run, name: m.name });
      const r = roleAt(k);
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
    // spec 1.1 §10: each milestone is a row; enter opens it on its digest
    for (const m of r.milestones)
      items.push({
        key: milestoneKey(r.id, m.name),
        selectable: true,
        render: (sel, w) => (
          <Line
            width={w}
            selected={sel}
            parts={[
              { text: "   " },
              m.landed
                ? { text: `${glyph("ok", ui.plain)} ${m.name}`, tone: "success" }
                : { text: `${glyph("waiting", ui.plain)} ${m.name}`, tone: "muted" },
              m.landed
                ? { text: m.what ? `  ${m.what}` : "", tone: "muted" }
                : { text: `  not landed${m.what ? ` · ${m.what}` : ""}`, tone: "muted" },
            ]}
          />
        ),
      });
    if (r.roles.length === 0) text(`none:${r.id}`, [{ text: "   no role has run yet", tone: "muted" }]);
    for (const x of r.roles) {
      const secs = x.live ? (now - Date.parse(x.since)) / 1000 : (x.secs ?? 0);
      const armed = isArmed(app.state, "cancel", `${x.run}/${x.name}`, app.clock.now());
      items.push({
        key: roleKey(x.run, x.dispatchId),
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

function RoleView(props: {
  run: string;
  dispatchId: string;
  width: number;
  height: number;
  refresher: Refresher;
}) {
  const app = useApp();
  const ui = useUi();
  const [selected, setSelected] = useSelection();
  // a role with its record is finished for good: nothing on its screen changes, so it is read no more
  // (r still reads it again)
  const [done, setDone] = useState(false);
  const polled = usePoll(() => app.effects.role(props.run, props.dispatchId), RUN_EVERY_MS, {
    paused: app.state.paused || done,
    key: `${props.run}/${props.dispatchId}`,
  });
  const recorded = polled.value?.record != null;
  useEffect(() => {
    if (recorded) setDone(true);
  }, [recorded]);
  useRefresher(props.refresher, polled.refresh);
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

/** Spec 1.1 §10: a milestone's screen, the digest `land` wrote for it. */
function MilestoneView(props: {
  run: string;
  name: string;
  width: number;
  height: number;
  refresher: Refresher;
}) {
  const app = useApp();
  const ui = useUi();
  const [selected, setSelected] = useSelection();
  const polled = usePoll(() => app.effects.milestone(props.run, props.name), RUN_EVERY_MS, {
    paused: app.state.paused,
    key: `${props.run}/${props.name}`,
  });
  useRefresher(props.refresher, polled.refresh);
  useBack(true, "view", () => app.dispatch({ type: "up" }));
  const d = polled.value;
  if (!d)
    return (
      <Line
        width={props.width}
        parts={[
          {
            text: polled.error ? ` ${polled.error}` : " reading the milestone…",
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
  line([{ text: " DIGEST", bold: true }]);
  const body = d.digest?.trimEnd() ?? "";
  if (!body)
    line([
      {
        text: `   no digest yet${d.landed ? "" : ": the milestone has not landed"}`,
        tone: "muted",
      },
    ]);
  else for (const l of body.split("\n")) for (const w of wrapHanging(l, room)) line([{ text: `   ${w}` }]);
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <Line
        width={props.width}
        parts={[
          { text: ` ${d.name}`, bold: true },
          {
            text: ` ${d.what ? `${d.what} · ` : ""}${d.landed ? "landed" : "not landed"} · ${d.runTitle}`,
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
 * live ones first), enter on a milestone opens its digest (spec 1.1 §10), enter on a role opens it (brief,
 * reply, record); esc goes back one level; p pauses.
 */
export function RunsView(props: { width: number; height: number }) {
  const app = useApp();
  const data = useData();
  const refresher: Refresher = useRef(null);
  useCommandLayer("tab.runs", {
    "runs.refresh": () => (refresher.current ?? data.sessions.refresh)(),
    "runs.pause": () => {
      app.dispatch({ type: "pause" });
      app.toast({ variant: "info", message: app.getState().paused ? "Updates paused" : "Updates resumed" });
    },
  });
  const { milestone, role, session, back } = app.state;
  // esc lands on the row it came from: the last session opened, and the last milestone or role opened in it
  const backRow =
    back && session && back.session === session.key
      ? back.milestone
        ? milestoneKey(back.milestone.run, back.milestone.name)
        : back.role
          ? roleKey(back.role.run, back.role.dispatchId)
          : null
      : null;
  if (milestone)
    return (
      <MilestoneView
        run={milestone.run}
        name={milestone.name}
        width={props.width}
        height={props.height}
        refresher={refresher}
      />
    );
  if (role)
    return (
      <RoleView
        run={role.run}
        dispatchId={role.dispatchId}
        width={props.width}
        height={props.height}
        refresher={refresher}
      />
    );
  if (session)
    return (
      <SessionView
        sessionKey={session.key}
        run={session.run}
        width={props.width}
        height={props.height}
        initial={backRow}
        refresher={refresher}
      />
    );
  return (
    <SessionList width={props.width} height={props.height} initial={back ? keyOf(back.session) : null} />
  );
}
