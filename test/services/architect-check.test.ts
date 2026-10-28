import { describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchCheck } from "../../src/domain/architect-state.ts";
import { db } from "../../src/infra/db.ts";
import { git } from "../../src/infra/git.ts";
import { runArchitectCheck } from "../../src/services/architect-check.ts";
import { createRun } from "../../src/services/run-store.ts";
import { tempRepo, withHome } from "../helpers.ts";
import { fakeDeps } from "./helpers.ts";

async function run() {
  withHome();
  const repo = tempRepo();
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const startHead = head.kind === "ok" ? head.out.trim() : "";
  return createRun({ repo, title: "t", aLines: ["A1 x"], version: "t", startHead });
}

const check = (checkId: string, command: string, o: Partial<ArchCheck> = {}): ArchCheck => ({
  checkId,
  command,
  scope: "full",
  base: false,
  fresh: false,
  state: "queued",
  ...o,
});

const opts = { timeoutMs: 60_000 };

describe("a check the architect asks for (plan 47, spec D6)", () => {
  it("records its failing lines and its log, and a row in checks", async () => {
    const r = await run();
    const done = await runArchitectCheck(
      fakeDeps(),
      r,
      check("C1", "echo '(fail) wallet > balance'; exit 1"),
      opts,
    );
    expect(done).toMatchObject({
      type: "check.done",
      checkId: "C1",
      exit: 1,
      failures: ["(fail) wallet > balance"],
      cached: false,
      preExisting: [],
    });
    expect(readFileSync(join(r.dir, done.logPath), "utf8")).toContain("(fail) wallet > balance");
    expect(db().query("SELECT check_id, exit, base FROM checks").all()).toEqual([
      { check_id: "C1", exit: 1, base: 0 },
    ]);
  });

  it("reuses a pass on the same tree, never a failure, and reruns on a changed tree or fresh", async () => {
    const r = await run();
    const deps = fakeDeps();
    expect((await runArchitectCheck(deps, r, check("C1", "true"), opts)).cached).toBe(false);
    expect((await runArchitectCheck(deps, r, check("C2", "true"), opts)).cached).toBe(true);
    expect((await runArchitectCheck(deps, r, check("C3", "true", { fresh: true }), opts)).cached).toBe(false);
    writeFileSync(join(r.meta.repo, "new.txt"), "x");
    expect((await runArchitectCheck(deps, r, check("C4", "true"), opts)).cached).toBe(false);
    await runArchitectCheck(deps, r, check("C5", "exit 3"), opts);
    expect((await runArchitectCheck(deps, r, check("C6", "exit 3"), opts)).cached).toBe(false);
  });

  it("checks the base on demand, on its start commit, and marks a failure the base has as pre-existing", async () => {
    const r = await run();
    const deps = fakeDeps();
    const cmd = "test -f new.txt && echo '(fail) new' ; echo '(fail) old'; exit 1";
    writeFileSync(join(r.meta.repo, "new.txt"), "x");
    const base = await runArchitectCheck(deps, r, check("C1", cmd, { base: true }), opts);
    expect(base.failures).toEqual(["(fail) old"]);
    const head = await runArchitectCheck(deps, r, check("C2", cmd), opts);
    expect(head.failures).toEqual(["(fail) new", "(fail) old"]);
    expect(head.preExisting).toEqual(["(fail) old"]);
    expect((await runArchitectCheck(deps, r, check("C3", cmd, { base: true }), opts)).cached).toBe(true);
  });
  it("gives each base check its own tree, and survives a stale registered one", async () => {
    const r = await run();
    const deps = fakeDeps();
    const sha = (r.meta.startHead as string).slice(0, 12);
    const stale = join(r.dir, "checks", `base-${sha}-C1`);
    await git(r.meta.repo, ["worktree", "add", "--detach", stale, r.meta.startHead as string]);
    rmSync(stale, { recursive: true, force: true });
    const both = await Promise.all([
      runArchitectCheck(deps, r, check("C1", "echo one", { base: true }), opts),
      runArchitectCheck(deps, r, check("C2", "echo two", { base: true }), opts),
    ]);
    expect(both.map((d) => d.exit)).toEqual([0, 0]);
  });
});
