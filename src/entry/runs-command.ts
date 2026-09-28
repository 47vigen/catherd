import { resolve } from "node:path";
import { defineCommand } from "citty";
import { formatBudget } from "../domain/budget.ts";
import { CatherdError } from "../domain/errors.ts";
import { gitToplevel } from "../infra/git.ts";
import { redact } from "../infra/log.ts";
import { cancel } from "../services/dispatch-service.ts";
import { registerSavedSecrets } from "../services/jev-service.ts";
import { runDebug } from "../services/run-debug.ts";
import { findRun, listRuns, readRecords, type Run } from "../services/run-store.ts";
import { groupRuns, type RunSession, type SessionGroup } from "../services/session-view.ts";
import { type RunSummary, status, summarizeRun } from "../services/summary.ts";
import { JSON_ARG, mark, printJson } from "./cli-kit.ts";
import { defaultDeps } from "./deps.ts";

const json = JSON_ARG;
const n = (x: number) => x.toLocaleString("en-US");

/** A session's heading in `runs list` and `status` (spec §4): `● live  <name>` or `· idle  <name>`. */
export function sessionHeading(s: RunSession | null): string {
  return s ? `session ${s.live ? "● live" : "· idle"}  ${s.name}` : "earlier runs";
}

/** How a run moved between sessions, after its line: `(continued here)`, `(continued in <name>)`. */
const movedNote = (g: SessionGroup["runs"][number]): string =>
  g.continued === "here" ? "  (continued here)" : g.continuedIn ? `  (continued in ${g.continuedIn})` : "";

/** One run at a glance: what is live, what finished, spend against the budget, landed milestones. */
export function formatRun(s: RunSummary, now: number = Date.now()): string[] {
  const t = s.totals;
  const lines = [
    `run ${s.id}  ${s.title}`,
    `  repo ${s.repo} · started ${s.createdAt} · ${Math.round((now - Date.parse(s.createdAt)) / 60_000)} min`,
  ];
  for (const l of s.live) lines.push(`  live ${l.name}  ${l.rung}  ${l.state} ${l.secs}s`);
  lines.push(
    `  done ${t.runs} role run(s), ${t.ok} ok${t.notOk.length ? `; not ok: ${t.notOk.join(", ")}` : ""}`,
    `  tokens ${n(t.tokens.input)} in (${n(t.tokens.cached)} cached) · ${n(t.tokens.output)} out · $${t.costUsd.toFixed(2)}` +
      (s.agents.runs
        ? ` · native agents ${s.agents.runs} run(s), ${n(s.agents.totalTokens)} tokens (reported)`
        : ""),
  );
  if (s.harness.length)
    lines.push(
      `  harness ${s.harness.map((h) => `${h.backend} ${h.native} native, ${h.isolated} isolated`).join(" · ")}`,
    );
  if (s.budget) lines.push(`  budget ${formatBudget(s.budget)}`);
  if (s.jev.decisions) lines.push(`  jev ${s.jev.decisions} decision(s), ${s.jev.fallbacks} fallback(s)`);
  for (const m of s.milestones) lines.push(`  landed ${m}`);
  if (s.verifier)
    lines.push(
      `  verifier step ${s.verifier.item}${s.verifier.carried ? " (carried over)" : ""} at ${s.verifier.at.slice(11, 16)}`,
    );
  for (const l of s.stateTail) lines.push(`  | ${l}`);
  for (const w of s.warnings) lines.push(`  ${mark("warn")} ${w}`);
  return lines;
}

function printStatus(runId: string | undefined, asJson: boolean): void {
  // redacted as `runs show` is: the state.md tail can quote a secret, and status goes to shared terminals
  registerSavedSecrets();
  const r = redact(status(defaultDeps(), runId));
  if (asJson) return printJson(r);
  if (r.runs.length === 0) console.log("no runs yet");
  // grouped by session, as the runs page is (spec §4); a run shows once, under the session that started it
  const byId = new Map(r.runs.map((s) => [s.id, s]));
  const runs = r.runs.flatMap((s) => {
    try {
      return [findRun(s.id)];
    } catch {
      return [];
    }
  });
  for (const g of groupRuns(runs)) {
    const own = g.runs.filter((x) => x.continued !== "here");
    if (own.length === 0) continue;
    console.log(sessionHeading(g.session));
    for (const x of own) {
      const s = byId.get(x.run.id);
      if (!s) continue;
      const [head, ...rest] = formatRun(s);
      console.log(`${head}${movedNote(x)}`);
      for (const l of rest) console.log(l);
    }
  }
  for (const w of r.warnings) console.log(`${mark("warn")} ${w}`);
}

/** Spec §8 `catherd status [run] [--json]`: that run, else every run with a live role, else the newest. */
export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "A run at a glance (default: runs with a live role, else the newest)",
  },
  args: { run: { type: "positional", required: false, description: "run id" }, ...json },
  run({ args }) {
    printStatus(args.run, args.json === true);
  },
});

/** `watch --interval <secs>` in ms: 2 s when absent, never under 1 s (so 0 means 1 s); not a number is refused. */
export function redrawMs(interval: string | undefined): number {
  if (interval === undefined) return 2000;
  const secs = interval.trim() === "" ? Number.NaN : Number(interval);
  if (!Number.isFinite(secs) || secs < 0)
    throw new CatherdError("E_INPUT_INVALID", `--interval takes a number of seconds, not "${interval}"`, {
      fix: "catherd watch --interval <seconds>",
    });
  return Math.max(1, secs) * 1000;
}

/** Spec §8 `catherd watch [--once]`: the TUI's Runs tab on a terminal, else a plain redraw. */
export const watchCommand = defineCommand({
  meta: {
    name: "watch",
    description:
      "The live runs: the dashboard's Runs tab on a terminal, else redrawn as text (--once: print once)",
  },
  args: {
    once: { type: "boolean", description: "print one snapshot and exit" },
    interval: { type: "string", description: "seconds between text redraws when piped (default 2)" },
    plain: {
      type: "boolean",
      description: "the dashboard in ASCII without colour (NO_COLOR also drops colour)",
    },
    "reduced-motion": { type: "boolean", description: "the dashboard without animation" },
    ...json,
  },
  async run({ args }) {
    const every = redrawMs(args.interval);
    if (args.once || args.json) return printStatus(undefined, args.json === true);
    // on a terminal, watch is the dashboard's Runs tab (plan 6 Ruling 10); piped output keeps the plain view
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const { openTui } = await import("./tui/run.tsx");
      const rawArgs = [
        ...(args.plain ? ["--plain"] : []),
        ...(args["reduced-motion"] ? ["--reduced-motion"] : []),
      ];
      process.exitCode = await openTui({ rawArgs, tab: "runs", tty: true });
      return;
    }
    for (;;) {
      if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
      printStatus(undefined, false);
      console.log(`updated ${new Date().toLocaleTimeString()} · Ctrl-C to stop`);
      await Bun.sleep(every);
    }
  },
});

const list = defineCommand({
  meta: { name: "list", description: "Every run, newest first" },
  args: { repo: { type: "string", description: "only the runs of the git repo at this path" }, ...json },
  async run({ args }) {
    const top = args.repo ? await gitToplevel(resolve(args.repo)) : null;
    if (args.repo && !top)
      throw new CatherdError("E_INPUT_INVALID", `${resolve(args.repo)} is not inside a git repository`, {
        fix: "pass a path inside the repo, or leave out --repo",
      });
    const { runs, corrupt } = listRuns();
    const shown = runs.filter((r) => !args.repo || r.meta.repo === top);
    const deps = defaultDeps();
    const row = (r: Run) => {
      const s = summarizeRun(deps, r);
      return {
        id: r.id,
        title: r.meta.title,
        repo: r.meta.repo,
        createdAt: r.meta.createdAt,
        live: s.live.length,
        roleRuns: s.totals.runs,
        session: s.session,
        continuedIn: s.continuedIn,
      };
    };
    const groups = groupRuns(shown);
    if (args.json) return printJson({ runs: shown.map(row), corrupt });
    if (shown.length === 0) console.log("no runs yet");
    for (const g of groups) {
      console.log(sessionHeading(g.session));
      for (const x of g.runs) {
        const r = row(x.run);
        console.log(
          `  ${r.id}  ${r.live ? `${r.live} live` : "idle"}  ${r.roleRuns} role run(s)  ${r.title}  ${r.repo}${movedNote(x)}`,
        );
      }
    }
    for (const c of corrupt) console.log(`${mark("warn")} skipped run ${c.id}: ${c.reason}`);
  },
});

const show = defineCommand({
  meta: {
    name: "show",
    description: "One run and its role runs; --debug adds exit.json and the stderr and event tails",
  },
  args: {
    id: { type: "positional", required: true, description: "run id" },
    debug: {
      type: "boolean",
      description: "per dispatch: the record, exit.json, and the stderr, event and supervisor tails",
    },
    name: { type: "string", description: "with --debug: only this role name" },
    ...json,
  },
  run({ args }) {
    const run = findRun(args.id);
    // every part redacted, not only the dispatches: state.md and a record's reply can quote a secret too;
    // the saved Jev key is a secret even in a process that never called Jev
    registerSavedSecrets();
    const { summary, records } = redact({
      summary: summarizeRun(defaultDeps(), run),
      records: readRecords(run).records,
    });
    const debug = args.debug ? runDebug(run, args.name) : undefined;
    if (args.json) return printJson({ summary, records, ...(debug ? { dispatches: debug } : {}) });
    for (const l of formatRun(summary)) console.log(l);
    for (const r of records)
      console.log(
        `  ${r.name}  ${r.rung}  ${r.status}${r.replyStatus ? `/${r.replyStatus}` : ""}  ${r.secs}s  ${n(r.tokens.input + r.tokens.output)} tokens`,
      );
    for (const d of debug ?? []) {
      console.log(`\n--- ${d.name} ${d.dispatchId} (${d.rung}, admitted ${d.admittedAt})`);
      console.log(`record: ${d.record ? JSON.stringify(d.record) : "none yet"}`);
      console.log(`exit.json: ${d.exit ? JSON.stringify(d.exit) : "none yet"}`);
      for (const [label, lines] of [
        ["stderr", d.stderrTail],
        ["events", d.eventsTail],
        ["supervisor.log", d.supervisorTail],
      ] as const) {
        console.log(`${label} (last ${lines.length} lines):`);
        for (const l of lines) console.log(`  ${l}`);
      }
    }
  },
});

const cancelCmd = defineCommand({
  meta: {
    name: "cancel",
    description: "Stop a live role (interrupt, SIGTERM, SIGKILL) and record it cancelled",
  },
  args: {
    id: { type: "positional", required: true, description: "run id" },
    name: { type: "positional", required: true, description: "the role's name, as status lists it" },
  },
  async run({ args }) {
    const r = await cancel(defaultDeps(), args.id, args.name);
    console.log(`${mark("ok")} ${r.record.name} ${r.record.status}`);
    for (const h of r.hints) console.log(`  ${h}`);
  },
});

/** Spec §8 `catherd runs list|show [--debug]|cancel`; a bare `catherd runs` lists them, as `status` needs no run. */
export const runsCommand = defineCommand({
  meta: { name: "runs", description: "Runs: list them (the default), show one, cancel a live role" },
  subCommands: { list, show, cancel: cancelCmd },
  default: "list",
});
