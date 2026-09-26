import type { Check } from "../../../services/doctor.ts";
import { useApp, useNow } from "../providers/app.tsx";
import { useData } from "../providers/data.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import { useUi } from "../providers/theme.tsx";
import { ago, wrap } from "../text.ts";
import { glyph, STATE_TOKEN } from "../theme.ts";
import { Line, type Part } from "../widgets/line.tsx";
import { List, type ListItem, useSelected } from "../widgets/list.tsx";
import { hereWord, type RunRow } from "../effects.ts";
import { showProfile } from "./profile-actions.ts";

/** `✓ ready` / `! not logged in` / `✗ missing`: state is always glyph and word (spec §9.3). */
export function stateParts(state: Check["state"], word: string, plain: boolean, pad = 16): Part[] {
  return [{ text: `${glyph(state, plain)} ${word}`.padEnd(pad), tone: STATE_TOKEN[state] }];
}

/** A run in one line: its state word first, then title, repo and progress (research C4). */
export function runParts(r: RunRow, now: number, plain: boolean): Part[] {
  const bits = [`${r.roleRuns} role run${r.roleRuns === 1 ? "" : "s"}`, `${r.landed} landed`];
  if (r.budget !== null) bits.push(`${Math.round(r.budget * 100)}% budget`);
  return [
    r.live
      ? { text: `${glyph("live", plain)} live  `, tone: "info" }
      : { text: `${glyph("dot", plain)} idle  `, tone: "muted" },
    { text: `${r.title}  `, bold: true },
    { text: `${r.repo}  `, tone: "muted" },
    { text: `${r.live ? `${r.live} live · ` : ""}${bits.join(" · ")}  `, tone: "muted" },
    { text: ago(now - Date.parse(r.createdAt)), tone: "muted" },
  ];
}

/**
 * Spec §9.1 tab 1: each check as `glyph word — detail` with its full fix command (y copies it), the
 * active profile, and the last five runs. enter opens the profile or a run.
 */
export function StatusView(props: { width: number; height: number }) {
  const app = useApp();
  const data = useData();
  const ui = useUi();
  const now = useNow(1_000);
  const { selected, select: setSelected, current: selectedNow } = useSelected();
  const checks = data.report?.checks ?? [];
  const profiles = data.profiles.value ?? { names: [], active: "…", here: "…", repo: null };
  const runs = (data.runs.value?.rows ?? []).slice(0, 5);
  const items: ListItem[] = [];
  const heading = (key: string, text: string, right = "") =>
    items.push({
      key,
      selectable: false,
      render: (_s, w) => (
        <Line
          width={w}
          parts={[
            { text, bold: true },
            { text: " ".repeat(Math.max(1, w - text.length - right.length - 1)) },
            { text: right, tone: "muted" },
          ]}
        />
      ),
    });
  const checked = data.checking
    ? "checking…"
    : data.checkedAt !== null
      ? `checked ${ago(now - data.checkedAt)}`
      : "";
  heading("h:setup", " SETUP", checked);
  if (data.checkError)
    items.push({
      key: "error",
      selectable: false,
      render: (_s, w) => (
        <Line
          width={w}
          parts={[{ text: `   ${glyph("fail", ui.plain)} ${data.checkError}`, tone: "error" }]}
        />
      ),
    });
  for (const c of checks) {
    // the detail wraps under the label instead of being cut: it is often a path (spec §9.3)
    const said = wrap(`${c.label}${c.detail ? ` — ${c.detail}` : ""}`, Math.max(20, props.width - 19));
    const first = said[0] ?? "";
    const label = first.startsWith(c.label) ? c.label : "";
    items.push({
      key: `check:${c.id}`,
      selectable: true,
      render: (sel, w) => (
        <Line
          width={w}
          selected={sel}
          parts={[
            { text: "   " },
            ...stateParts(c.state, c.word, ui.plain),
            { text: label, bold: true },
            { text: first.slice(label.length), tone: "muted" },
          ]}
        />
      ),
    });
    said.slice(1).forEach((line, i) =>
      items.push({
        key: `detail:${c.id}:${i}`,
        selectable: false,
        render: (_s, w) => <Line width={w} parts={[{ text: `${" ".repeat(19)}${line}`, tone: "muted" }]} />,
      }),
    );
    if (c.fix)
      wrap(`fix: ${c.fix}`, Math.max(20, props.width - 22)).forEach((line, i) =>
        items.push({
          key: `fix:${c.id}:${i}`,
          selectable: false,
          render: (_s, w) => <Line width={w} parts={[{ text: `${" ".repeat(20)}${line}`, tone: "muted" }]} />,
        }),
      );
  }
  heading("h:profile", " PROFILE");
  // until the first check is in, nothing is selectable, so the cursor starts on the first check
  const ready = data.report !== null || data.checkError !== null;
  items.push({
    key: "profile",
    selectable: ready,
    render: (sel, w) => (
      <Line
        width={w}
        selected={sel}
        parts={[
          { text: `   ${profiles.here}`, bold: true },
          {
            text: `  ${hereWord(profiles)} · ${profiles.names.length} profile${profiles.names.length === 1 ? "" : "s"}`,
            tone: "muted",
          },
        ]}
      />
    ),
  });
  heading("h:runs", " RECENT RUNS");
  if (runs.length === 0)
    items.push({
      key: "runs:none",
      selectable: false,
      render: (_s, w) => <Line width={w} parts={[{ text: "   no runs yet", tone: "muted" }]} />,
    });
  for (const r of runs)
    items.push({
      key: `run:${r.id}`,
      selectable: ready,
      render: (sel, w) => (
        <Line width={w} selected={sel} parts={[{ text: "   " }, ...runParts(r, now, ui.plain)]} />
      ),
    });

  const checkAt = (key: string | null) => checks.find((c) => key === `check:${c.id}`);
  useCommandLayer("tab.status", {
    "status.recheck": () => data.recheck(),
    "status.copy": () => {
      const selectedCheck = checkAt(selectedNow());
      if (!selectedCheck?.fix) return app.toast({ variant: "info", message: "This row has no fix command" });
      const ok = app.copy(selectedCheck.fix);
      app.toast(
        ok
          ? { variant: "success", message: "Copied the fix command" }
          : { variant: "warning", message: "This terminal cannot copy; the command is shown in full" },
      );
    },
  });
  useCommandLayer("row.status", {
    "status.open": () => {
      const selected = selectedNow();
      const selectedCheck = checkAt(selected);
      // the PROFILE row is what this directory runs on; doctor's `profile` row is the global active one,
      // and its `profile:<name>` rows are the repo-bound ones
      const name =
        selected === "profile"
          ? profiles.here
          : selectedCheck?.id === "profile"
            ? profiles.active
            : selectedCheck?.id.startsWith("profile:")
              ? selectedCheck.id.slice("profile:".length)
              : null;
      if (name !== null) {
        showProfile(app, name);
      } else if (selected?.startsWith("run:")) {
        app.dispatch({ type: "tab", tab: "runs" });
        app.dispatch({ type: "run", id: selected.slice("run:".length) });
      }
    },
  });
  return (
    <List
      items={items}
      selected={selected}
      onSelect={setSelected}
      width={props.width}
      height={props.height}
      empty="checking…"
    />
  );
}
