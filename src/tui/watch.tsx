import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { type BudgetStatus, formatBudget, type RunSummary, summarizeRun } from "../core/status.ts";
import { listRuns, readRunRecords, type Run } from "../core/runstore.ts";
import type { RunRecord, RungId } from "../types.ts";
import { face, glyph, tint, type Ui } from "./theme.ts";
import { CatSpinner, DetailPane, Frame, gradientLetters, ListLine } from "./ui.tsx";
import {
  budgetTone,
  climbs,
  jevLine,
  type JevLine,
  liveLine,
  plainBudgetBar,
  readJev,
  runLine,
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
  readJev,
};

// ponytail: only the 20 newest runs are summarized each poll; add paging when someone keeps more than that live
const MAX_RUNS = 20;
const LEFT_HEIGHT = 12;

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
      >{`${plainBudgetBar(budget.fraction, width)} ${formatBudget(budget)}`}</text>
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

/** The right pane for the highlighted run: its live lanes, recent climbs, Jev decisions and the
 * budget bar — the run's records and raw state text stay out (they were noise, spec §item 4). */
function RunDetail({ ui, it, climbed, deps }: { ui: Ui; it: Item; climbed: string[]; deps: WatchDeps }) {
  const pink = tint("pink", ui.depth);
  if (!it.summary) {
    return (
      <DetailPane ui={ui} title={it.run.id} subtitle="unreadable">
        <text fg={pink} wrapMode="none" truncate>
          {`${face("failed", ui.plain)} ${it.error}`}
        </text>
      </DetailPane>
    );
  }
  const s = it.summary;
  const jev = deps.readJev(it.run.dir);
  return (
    <DetailPane ui={ui} title={s.title} subtitle={it.run.meta.repo}>
      {s.live.length > 0 ? (
        s.live.map((l) => (
          <text key={l.name} wrapMode="none" truncate>
            {liveLine(l, ui.plain)}
          </text>
        ))
      ) : (
        <text attributes={TextAttributes.DIM}>no lane is running right now</text>
      )}
      {climbed.length > 0 ? (
        <>
          <text> </text>
          {climbed.map((c, i) => (
            <text key={`c${i}`} fg={pink} wrapMode="none" truncate>
              {c}
            </text>
          ))}
        </>
      ) : null}
      <text> </text>
      <text attributes={TextAttributes.DIM}>
        {`jev ${glyph("dot", ui.plain)} ${s.jev.decisions} decisions ${glyph("dot", ui.plain)} ${s.jev.fallbacks} fell back`}
      </text>
      {jev.slice(-4).map((e, i) => (
        <text key={`j${i}`} wrapMode="none" truncate>
          {jevLine(e, ui.plain)}
        </text>
      ))}
      {s.budget ? (
        <>
          <text> </text>
          <BudgetBar ui={ui} budget={s.budget} />
        </>
      ) : null}
    </DetailPane>
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
  const leftStart = Math.max(0, Math.min(at - Math.floor(LEFT_HEIGHT / 2), items.length - LEFT_HEIGHT));

  useKeyboard((key) => {
    if (key.sequence === "q") {
      renderer.destroy();
      return;
    }
    if (key.name === "up") setCursor(Math.max(0, at - 1));
    else if (key.name === "down") setCursor(Math.min(items.length - 1, at + 1));
  });

  const pink = tint("pink", ui.depth);
  const title = `Watch ${glyph("dot", ui.plain)} ${items.length} runs`;
  const hint = `${glyph("keys", ui.plain)} navigate   q quit   refreshes every ${intervalMs / 1000} s`;

  if (state?.problem) {
    return (
      <Frame ui={ui} title={title} hint="q quit">
        <text fg={pink} wrapMode="none" truncate>{`${face("failed", ui.plain)} ${state.problem}`}</text>
      </Frame>
    );
  }

  return (
    <Frame ui={ui} title={title} hint={hint}>
      {state === null ? (
        <CatSpinner ui={ui} label="reading the runs" />
      ) : items.length === 0 ? (
        <text>No runs yet. Start one with /catherd in Claude Code.</text>
      ) : (
        <box style={{ flexDirection: "row" }}>
          <box style={{ flexDirection: "column", width: 24 }}>
            <text fg={pink} attributes={TextAttributes.BOLD}>
              RUNS
            </text>
            {items.slice(leftStart, leftStart + LEFT_HEIGHT).map((it, i) => (
              <ListLine
                key={it.run.dir}
                ui={ui}
                selected={leftStart + i === at}
                dim={!it.summary}
                text={
                  it.summary
                    ? runLine(it.summary, ui.plain)
                    : `${face("failed", ui.plain)} ${it.run.id} ${glyph("dot", ui.plain)} unreadable: ${it.error}`
                }
              />
            ))}
          </box>
          {items[at] ? <RunDetail ui={ui} it={items[at]} climbed={climbed} deps={d} /> : null}
        </box>
      )}
    </Frame>
  );
}
