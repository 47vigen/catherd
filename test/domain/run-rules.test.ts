import { describe, expect, it } from "bun:test";
import { budgetStatus, formatBudget } from "../../src/domain/budget.ts";
import { changedPaths, parsePorcelainZ, splitChanges } from "../../src/domain/changes.ts";
import { dispatchHints } from "../../src/domain/hints.ts";
import { currentRoute, nextRung, type RouteRow } from "../../src/domain/route.ts";
import { renderState } from "../../src/domain/state.ts";
import { makeRecord } from "./make-record.ts";

const row = (lane: string, rung: string, source: RouteRow["source"] = "route"): RouteRow => ({
  at: "2026-09-25T10:00:00.000Z",
  lane,
  role: "worker",
  rung,
  ladder: ["codex:a#low", "codex:a#high"],
  source,
  decidedBy: "lane",
  from: null,
  reason: null,
  kind: "repo_code",
  difficulty: "build",
});

describe("routes", () => {
  it("climbs one rung and stops at the top", () => {
    expect(nextRung(["a", "b", "c"], "a")).toBe("b");
    expect(nextRung(["a", "b", "c"], "c")).toBeNull();
    expect(nextRung(["a", "b"], "x")).toBeNull();
  });

  it("takes a lane's last row as its current route", () => {
    const rows = [row("L1", "codex:a#low"), row("L2", "codex:a#low"), row("L1", "codex:a#high", "climb")];
    expect(currentRoute(rows, "L1")?.rung).toBe("codex:a#high");
    expect(currentRoute(rows, "L9")).toBeNull();
  });
});

describe("budgetStatus", () => {
  const spend = { minutes: 30, tokens: 500, usd: 1 };

  it("is null when the profile sets no cap", () => {
    expect(budgetStatus(spend, {})).toBeNull();
  });

  it("reports the highest fraction over the caps set", () => {
    const b = budgetStatus(spend, { minutes: 60, tokens: 1000, usd: 4 });
    expect(b?.fraction).toBe(0.5);
    expect(formatBudget(b!)).toBe("30/60 min · 500/1000 tokens · $1.00/$4.00 (50%)");
  });

  it("treats spend exactly at the cap, or any spend against a zero cap, as spent", () => {
    expect(budgetStatus(spend, { tokens: 500 })?.fraction).toBe(1);
    expect(budgetStatus(spend, { usd: 0 })?.fraction).toBe(1);
    expect(budgetStatus({ minutes: 0, tokens: 0, usd: 0 }, { usd: 0 })?.fraction).toBe(0);
  });
});

describe("dispatchHints", () => {
  const dir = "roles/w/01J";

  it("says nothing for an ok run that changed its owned files", () => {
    expect(dispatchHints(makeRecord(), ["src/a.ts"], dir)).toEqual([]);
  });

  it("flags a refusal, a block, and an ok run that left its owned files unchanged", () => {
    expect(dispatchHints(makeRecord({ replyStatus: "refused" }), ["src/a.ts"], dir)).toEqual([
      "climb: refused",
    ]);
    expect(dispatchHints(makeRecord({ replyStatus: "blocked" }), [], dir)).toEqual(["climb: blocked"]);
    expect(dispatchHints(makeRecord({ changedOwned: [] }), ["src/a.ts"], dir)).toEqual(["climb: unchanged"]);
    expect(dispatchHints(makeRecord({ changedOwned: [] }), [], dir)).toEqual([]);
  });

  it("never says unchanged for a read-only role on a lane", () => {
    const r = makeRecord({ access: "read-only", changedOwned: [] });
    expect(dispatchHints(r, ["src/a.ts"], dir)).toEqual([]);
  });

  it("names the stderr of a failed run, a limit, an old CLI, violations and a heavy thread", () => {
    expect(dispatchHints(makeRecord({ status: "failed", replyStatus: null }), [], dir)).toEqual([
      "failed: read roles/w/01J/stderr",
    ]);
    expect(dispatchHints(makeRecord({ status: "limit", replyStatus: null }), [], dir)).toEqual([
      "limit: codex hit a usage limit on codex:gpt-6-sol#medium",
    ]);
    const old = makeRecord({
      status: "cli-too-old",
      error: { code: "cli-too-old", message: "upgrade codex" },
    });
    expect(dispatchHints(old, [], dir)).toEqual(["cli-too-old: upgrade codex"]);
    const r = makeRecord({ violations: ["src/x.ts", "b.md"], threadHeavy: true });
    expect(dispatchHints(r, ["src/a.ts"], dir)).toEqual(["violation: src/x.ts, b.md", "thread-heavy"]);
  });
});

describe("change detection", () => {
  it("parses porcelain -z, reporting both paths of a rename in either column", () => {
    const out =
      " M src/a.ts\0?? new dir/b.ts\0R  src/c.ts\0src/old.ts\0 R src/d.ts\0lib/d.ts\0" +
      "C  src/e.ts\0src/f.ts\0D  gone.ts\0";
    expect(parsePorcelainZ(out)).toEqual([
      { xy: " M", path: "src/a.ts" },
      { xy: "??", path: "new dir/b.ts" },
      { xy: "R ", path: "src/c.ts" },
      { xy: "R ", path: "src/old.ts" },
      { xy: " R", path: "src/d.ts" },
      { xy: " R", path: "lib/d.ts" },
      { xy: "C ", path: "src/e.ts" },
      { xy: "C ", path: "src/f.ts" },
      { xy: "D ", path: "gone.ts" },
    ]);
  });

  it("counts an edit to a file that was already dirty, and ignores one that became clean", () => {
    const before = { "a.ts": " M 10 1", "b.ts": " M 5 1", "c.ts": "?? 1 1" };
    const after = { "a.ts": " M 12 2", "b.ts": " M 5 1", "d.ts": "?? 3 3" };
    expect(changedPaths(before, after)).toEqual(["a.ts", "d.ts"]);
  });

  it("splits changes into owned ones and violations, sparing paths an overlapping dispatch owns", () => {
    const changed = ["src/a.ts", "src/lib/b.ts", "docs/x.md", "other/y.ts"];
    expect(splitChanges(changed, ["src/"], ["docs/"], true)).toEqual({
      changedOwned: ["src/a.ts", "src/lib/b.ts"],
      violations: ["other/y.ts"],
    });
    expect(splitChanges(changed, [], [], false)).toEqual({ changedOwned: [], violations: [] });
    expect(splitChanges(["a.ts"], [], [], true).violations).toEqual(["a.ts"]);
  });
});

describe("renderState", () => {
  const base = {
    title: "Add login",
    head: "abc1234",
    dirty: [],
    running: [],
    lastCheck: null,
    next: "plan the milestones",
  };

  it("renders an idle run with the next step on the last line", () => {
    const text = renderState(base);
    expect(text.startsWith("# Add login\n\nHEAD abc1234\n")).toBe(true);
    expect(text).toContain("Dirty:\n- none");
    expect(text).toContain("Running:\n- none");
    expect(text.trimEnd().split("\n").at(-1)).toBe("Next: plan the milestones");
  });

  it("names dirty owners and running roles, and waits for them first", () => {
    const text = renderState({
      ...base,
      dirty: [
        { path: "src/a.ts", owner: "worker-M1.L1" },
        { path: "b.md", owner: null },
      ],
      running: [
        {
          name: "worker-M1.L1",
          rung: "codex:a#high",
          thread: null,
          since: "10:00",
          brief: "roles/w/1/brief.md",
        },
      ],
      lastCheck: "bun test 12/12",
      next: "review M1",
    });
    expect(text).toContain("- src/a.ts (worker-M1.L1)\n- b.md\n");
    expect(text).toContain("- worker-M1.L1 · codex:a#high · thread new · since 10:00 · roles/w/1/brief.md");
    expect(text).toContain("Last check: bun test 12/12");
    expect(text.trimEnd().split("\n").at(-1)).toBe("Next: wait for worker-M1.L1; then review M1");
  });
});
