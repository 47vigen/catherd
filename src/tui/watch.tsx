import { join } from "node:path";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { type BudgetStatus, formatBudget, type RunSummary, summarizeRun } from "../core/status.ts";
import { listRuns, readJsonl, readRunRecords, type Run } from "../core/runstore.ts";
import type { RunRecord, RungId } from "../types.ts";
import { face, glyph, type Mood, tint, type Ui } from "./theme.ts";
import { CatSpinner, Header, Screen, gradientLetters } from "./ui.tsx";
import {
  budgetTone,
  climbs,
  jevLine,
  type JevLine,
  liveLine,
  milestoneLine,
  plainBudgetBar,
  recordLine,
  runLine,
  runMood,
} from "./watch-model.ts";

export interface WatchDeps {
  listRuns: () => Run[];
  summarizeRun: (run: Run) => RunSummary;
  readRunRecords: (dir: string) => RunRecord[];
  readJev: (dir: string) => JevLine[];
}

const watchDeps: WatchDeps = {
  listRuns,
  summarizeRun,
  readRunRecords,
  readJev: (dir) => readJsonl<JevLine>(join(dir, "jev.jsonl")),
};

// ponytail: only the 20 newest runs are summarized each poll; add paging when someone keeps more than that live
const MAX_RUNS = 20;
const SHOWN = 6;

interface Item {
  run: Run;
  summary: RunSummary | null;
  error: string | null;
}

function poll(d: WatchDeps): { items: Item[]; problem: string | null } {
  try {
    const items = d
      .listRuns()
      .slice(0, MAX_RUNS)
      .map((run): Item => {
        try {
          return { run, summary: d.summarizeRun(run), error: null };
        } catch (e) {
          return { run, summary: null, error: (e as Error).message };
        }
      });
    return { items, problem: null };
  } catch (e) {
    return { items: [], problem: (e as Error).message };
  }
}

/** spec §11b: a bar in the ginger-to-pink gradient, solid ginger from 80% spent and solid pink once
 * the budget is exhausted (the palette has no dedicated warning/error tones, see watch-model.ts). */
function BudgetBar({ ui, budget }: { ui: Ui; budget: BudgetStatus }) {
  const width = 10;
  if (ui.plain) {
    return (
      <text
        wrapMode="none"
        truncate
      >{`    ${plainBudgetBar(budget.fraction, width)} ${formatBudget(budget)}`}</text>
    );
  }
  const filled = Math.round(Math.max(0, Math.min(1, budget.fraction)) * width);
  const tone = budgetTone(budget.fraction);
  const solid =
    tone === "error" ? tint("pink", ui.depth) : tone === "warning" ? tint("ginger", ui.depth) : null;
  const cells = solid
    ? Array.from({ length: filled }, () => ({ ch: "█", fg: solid }))
    : gradientLetters("█".repeat(filled));
  return (
    <text wrapMode="none" truncate>
      {"    "}
      {cells.map((cell, i) => (
        // biome-ignore lint: index key is stable, the bar never reorders
        <span key={i} fg={cell.fg}>
          {cell.ch}
        </span>
      ))}
      <span attributes={TextAttributes.DIM}>{"░".repeat(width - filled)}</span>
      {` ${formatBudget(budget)}`}
    </text>
  );
}

function RunBlock({ ui, it, here }: { ui: Ui; it: Item; here: boolean }) {
  const cur = here ? glyph("cursor", ui.plain) : " ";
  if (!it.summary) {
    return (
      <text wrapMode="none" truncate attributes={TextAttributes.DIM}>
        {`${cur} ${face("failed", ui.plain)} ${it.run.id} ${glyph("dot", ui.plain)} unreadable: ${it.error}`}
      </text>
    );
  }
  const s = it.summary;
  const ginger = tint("ginger", ui.depth);
  const pink = tint("pink", ui.depth);
  return (
    <box style={{ flexDirection: "column" }}>
      <text
        wrapMode="none"
        truncate
        attributes={here ? TextAttributes.BOLD : TextAttributes.NONE}
      >{`${cur} ${runLine(s, ui.plain)}`}</text>
      {s.live.map((l) => (
        <text key={l.name} wrapMode="none" truncate fg={ginger}>{`    ${liveLine(l, ui.plain)}`}</text>
      ))}
      {s.milestones.map((m) => (
        <text key={m} wrapMode="none" truncate fg={pink}>{`    ${milestoneLine(m, ui.plain)}`}</text>
      ))}
      {s.budget ? <BudgetBar ui={ui} budget={s.budget} /> : null}
    </box>
  );
}

function Detail({ ui, run, summary, deps }: { ui: Ui; run: Run; summary: RunSummary; deps: WatchDeps }) {
  const records = deps.readRunRecords(run.dir);
  const jev = deps.readJev(run.dir);
  const dot = ` ${glyph("dot", ui.plain)} `;
  const ginger = tint("ginger", ui.depth);
  return (
    <box style={{ flexDirection: "column" }}>
      <text
        wrapMode="none"
        truncate
        attributes={TextAttributes.DIM}
      >{`${run.meta.repo}${dot}${run.id}`}</text>
      <text fg={ginger} attributes={TextAttributes.BOLD}>
        state
      </text>
      {summary.stateTail.map((l, i) => (
        <text key={`s${i}`} wrapMode="none" truncate>{`  ${l}`}</text>
      ))}
      <text fg={ginger} attributes={TextAttributes.BOLD}>{`records${dot}${records.length}`}</text>
      {records.slice(-8).map((r, i) => (
        <text key={`r${i}`} wrapMode="none" truncate>{`  ${recordLine(r, ui.plain)}`}</text>
      ))}
      <text fg={ginger} attributes={TextAttributes.BOLD}>
        {`jev${dot}${summary.jev.decisions} decisions${dot}${summary.jev.fallbacks} fell back`}
      </text>
      {jev.slice(-6).map((e, i) => (
        <text key={`j${i}`} wrapMode="none" truncate>{`  ${jevLine(e, ui.plain)}`}</text>
      ))}
      <text attributes={TextAttributes.DIM}>{`esc back${dot}q quit`}</text>
    </box>
  );
}

export function Watch({
  ui,
  deps = {},
  intervalMs = 2000,
}: {
  ui: Ui;
  deps?: Partial<WatchDeps>;
  intervalMs?: number;
}) {
  const d = { ...watchDeps, ...deps };
  const renderer = useRenderer();
  const seen = useRef(new Map<string, RungId>());
  const [state, setState] = useState<{ items: Item[]; problem: string | null } | null>(null);
  const [climbed, setClimbed] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => {
      const next = poll(d);
      const fresh = next.items.flatMap((it) =>
        it.summary ? climbs(seen.current, it.summary, ui.plain) : [],
      );
      if (fresh.length > 0) setClimbed((c) => [...fresh, ...c].slice(0, 3));
      setState(next);
    };
    refresh();
    const t = setInterval(refresh, intervalMs);
    return () => clearInterval(t);
  }, []);

  const items = state?.items ?? [];
  const at = Math.min(cursor, Math.max(0, items.length - 1));
  const detail = items.find((it) => it.run.dir === open);

  useKeyboard((key) => {
    if (key.sequence === "q") {
      renderer.destroy();
      return;
    }
    if (detail) {
      if (key.name === "escape" || key.name === "left" || key.name === "return") setOpen(null);
      return;
    }
    const it = items[at];
    if (key.name === "up") setCursor(Math.max(0, at - 1));
    else if (key.name === "down") setCursor(Math.min(items.length - 1, at + 1));
    else if (key.name === "return" && it?.summary) setOpen(it.run.dir);
  });

  const summaries = items.flatMap((it) => (it.summary ? [it.summary] : []));
  const mood: Mood =
    state === null || summaries.some((s) => s.live.length > 0)
      ? "working"
      : state.problem || items.some((it) => it.error) || summaries.some((s) => runMood(s) === "failed")
        ? "failed"
        : items.length > 0
          ? "good"
          : "waiting";
  const dot = ` ${glyph("dot", ui.plain)} `;
  const pink = tint("pink", ui.depth);
  const start = Math.max(0, Math.min(at - Math.floor(SHOWN / 2), items.length - SHOWN));

  return (
    <Screen>
      <Header
        ui={ui}
        mood={mood}
        title={detail ? `watch${dot}${detail.run.meta.title}` : `watch${dot}${items.length} runs`}
      />
      {detail?.summary ? (
        <Detail ui={ui} run={detail.run} summary={detail.summary} deps={d} />
      ) : (
        <box style={{ flexDirection: "column" }}>
          {state === null ? <CatSpinner ui={ui} label="reading the runs" /> : null}
          {state?.problem ? (
            <text fg={pink} wrapMode="none" truncate>{`${face("failed", ui.plain)} ${state.problem}`}</text>
          ) : null}
          {state !== null && !state.problem && items.length === 0 ? (
            <text>No runs yet. Start one with /catherd in Claude Code.</text>
          ) : null}
          {items.slice(start, start + SHOWN).map((it, i) => (
            <RunBlock key={it.run.dir} ui={ui} it={it} here={start + i === at} />
          ))}
          {climbed.map((c, i) => (
            <text key={`c${i}`} fg={pink} wrapMode="none" truncate>
              {c}
            </text>
          ))}
          <text attributes={TextAttributes.DIM} wrapMode="none" truncate>
            {`${glyph("keys", ui.plain)} move${dot}enter details${dot}q quit${dot}refreshes every ${intervalMs / 1000} s`}
          </text>
        </box>
      )}
    </Screen>
  );
}
