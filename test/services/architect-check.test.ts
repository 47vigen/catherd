import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("never records a pass against a tree the check itself changed", async () => {
    const r = await run();
    const deps = fakeDeps();
    expect((await runArchitectCheck(deps, r, check("C1", "touch made.txt"), opts)).exit).toBe(0);
    rmSync(join(r.meta.repo, "made.txt"));
    expect((await runArchitectCheck(deps, r, check("C2", "touch made.txt"), opts)).cached).toBe(false);
  });

  it("a cached result points at a log that exists, also when it was cached from a cached one", async () => {
    const r = await run();
    const deps = fakeDeps();
    await runArchitectCheck(deps, r, check("C1", "echo ok-line"), opts);
    for (const id of ["C2", "C3"]) {
      const done = await runArchitectCheck(deps, r, check(id, "echo ok-line"), opts);
      expect(done.cached).toBe(true);
      expect(existsSync(join(r.dir, done.logPath))).toBe(true);
    }
  });

  it("names the commit it ran on, and not a commit the check itself made", async () => {
    const r = await run();
    const deps = fakeDeps();
    const head = async () => {
      const h = await git(r.meta.repo, ["rev-parse", "HEAD"]);
      return h.kind === "ok" ? h.out.trim() : "";
    };
    const ref = (id: string) =>
      (db().query("SELECT ref FROM checks WHERE check_id = ?").get(id) as { ref: string }).ref;
    const start = await head();
    await runArchitectCheck(deps, r, check("C1", "true"), opts);
    expect(ref("C1")).toBe(start);
    await runArchitectCheck(
      deps,
      r,
      check("C2", "git -c user.name=t -c user.email=t@t commit -q --allow-empty -m made", { fresh: true }),
      opts,
    );
    expect(await head()).not.toBe(start);
    expect(ref("C2")).toBe("worktree");
  });

  it("records a full check against the commit when the repo has a clean initialized submodule", async () => {
    const r = await run();
    const source = tempRepo();
    const sub = (cwd: string, ...a: string[]) => git(cwd, ["-c", "protocol.file.allow=always", ...a]);
    await git(r.meta.repo, ["config", "user.name", "t"]);
    await git(r.meta.repo, ["config", "user.email", "t@t"]);
    await sub(r.meta.repo, "submodule", "add", "-q", source, "lib");
    await git(r.meta.repo, ["commit", "-qm", "add lib"]);
    const head = await git(r.meta.repo, ["rev-parse", "HEAD"]);
    const sha = head.kind === "ok" ? head.out.trim() : "";
    const ref = (id: string) =>
      (db().query("SELECT ref FROM checks WHERE check_id = ?").get(id) as { ref: string }).ref;
    await runArchitectCheck(fakeDeps(), r, check("C1", "true"), opts);
    expect(ref("C1")).toBe(sha);
    writeFileSync(join(r.meta.repo, "lib", "dirty.txt"), "x");
    await runArchitectCheck(fakeDeps(), r, check("C2", "true"), opts);
    expect(ref("C2")).toBe("worktree");
  });
});
