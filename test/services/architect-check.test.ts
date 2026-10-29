import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArchCheck } from "../../src/domain/architect-state.ts";
import { db } from "../../src/infra/db.ts";
import { git } from "../../src/infra/git.ts";
import { runArchitectCheck } from "../../src/services/architect-check.ts";
import { createRun, runPaths } from "../../src/services/run-store.ts";
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
      check("C1", "echo '(fail) wallet > balance'; exit 1", { scope: "fast" }),
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
  it("compares a failing full check with the base itself, once per base commit, and splits new from inherited", async () => {
    const r = await run();
    const deps = fakeDeps();
    const cmd = "if test -f new.txt; then echo '(fail) new'; fi; echo '(fail) old'; exit 1";
    const inherited = await runArchitectCheck(deps, r, check("C1", cmd), opts);
    expect(inherited).toMatchObject({
      verdict: "inherited",
      failures: ["(fail) old"],
      preExisting: ["(fail) old"],
    });
    writeFileSync(join(r.meta.repo, "new.txt"), "x");
    const fresh = await runArchitectCheck(deps, r, check("C2", cmd), opts);
    expect(fresh).toMatchObject({ verdict: "new", preExisting: ["(fail) old"] });
    expect(db().query("SELECT check_id, base, cached, verdict FROM checks ORDER BY id").all()).toEqual([
      { check_id: "C1-base", base: 1, cached: 0, verdict: null },
      { check_id: "C1", base: 0, cached: 0, verdict: "inherited" },
      { check_id: "C2-base", base: 1, cached: 1, verdict: null },
      { check_id: "C2", base: 0, cached: 0, verdict: "new" },
    ]);
  });

  it("calls a failure it cannot read unknown when the base fails too, and never runs the base for a fast check", async () => {
    const r = await run();
    const deps = fakeDeps();
    expect((await runArchitectCheck(deps, r, check("C1", "exit 2"), opts)).verdict).toBe("unknown");
    writeFileSync(join(r.meta.repo, "new.txt"), "x");
    expect((await runArchitectCheck(deps, r, check("C2", "test ! -f new.txt"), opts)).verdict).toBe("new");
    const fast = await runArchitectCheck(
      deps,
      r,
      check("C3", "echo '(fail) x'; exit 1", { scope: "fast" }),
      opts,
    );
    expect(fast.verdict).toBeUndefined();
    expect(db().query("SELECT check_id FROM checks WHERE base = 1 ORDER BY id").all()).toEqual([
      { check_id: "C1-base" },
      { check_id: "C2-base" },
    ]);
  });

  it("reads the failing lines from the whole output, not its tail (plan 52)", async () => {
    const r = await run();
    const deps = fakeDeps();
    writeFileSync(join(r.meta.repo, "new.txt"), "x");
    const cmd = "test -f new.txt && echo '(fail) new'; seq 1 1500; echo '(fail) old'; exit 1";
    expect(await runArchitectCheck(deps, r, check("C1", cmd), opts)).toMatchObject({
      verdict: "new",
      failures: ["(fail) new", "(fail) old"],
    });
  });

  it("calls a failure unknown when a leftover held the pipes open and the output was cut (plan 52)", async () => {
    const r = await run();
    const done = await runArchitectCheck(
      fakeDeps(),
      r,
      check("C1", "(sleep 30 &); echo '(fail) old'; exit 1"),
      opts,
    );
    expect(done).toMatchObject({ verdict: "unknown", failures: ["(fail) old"] });
  });

  it("is inherited only when the failing part of an && chain is the last, on both sides (plan 52)", async () => {
    const r = await run();
    const deps = fakeDeps();
    const fail = "{ echo '(fail) old'; exit 1; }";
    expect((await runArchitectCheck(deps, r, check("C1", `true && ${fail}`), opts)).verdict).toBe(
      "inherited",
    );
    // an early part fails: the later ones never ran on either side
    expect((await runArchitectCheck(deps, r, check("C2", `${fail} && true`), opts)).verdict).toBe("unknown");
    // a || can run a later part after a failed one, so the marks say nothing
    expect((await runArchitectCheck(deps, r, check("C3", `true && ${fail} || exit 1`), opts)).verdict).toBe(
      "unknown",
    );
  });

  it("does not take an early failure behind a leading cd for the whole chain (plan 52)", async () => {
    const r = await run();
    const deps = fakeDeps();
    const fail = "{ echo '(fail) lint'; exit 1; }";
    // lint fails on both sides and the test part never ran
    expect(
      (await runArchitectCheck(deps, r, check("C1", `mkdir -p web && cd web && ${fail} && true`), opts))
        .verdict,
    ).toBe("unknown");
    // the last part failing on both sides is comparable
    expect(
      (await runArchitectCheck(deps, r, check("C2", `mkdir -p web && cd web && true && ${fail}`), opts))
        .verdict,
    ).toBe("inherited");
  });

  it("does not run the base after a timeout, and never reuses a base result that timed out (plan 52)", async () => {
    const r = await run();
    const deps = fakeDeps();
    const timed = await runArchitectCheck(deps, r, check("C1", "sleep 1"), { timeoutMs: 300 });
    expect(timed).toMatchObject({ exit: null, verdict: "unknown" });
    expect(db().query("SELECT check_id FROM checks WHERE base = 1").all()).toEqual([]);
    const cut = await runArchitectCheck(deps, r, check("C2", "sleep 1", { base: true }), { timeoutMs: 300 });
    expect(cut.exit).toBeNull();
    const again = await runArchitectCheck(deps, r, check("C3", "sleep 1", { base: true }), opts);
    expect(again).toMatchObject({ exit: 0, cached: false });
  });

  it("sets the base tree up like the run's tree, with the plan's Setup: (plan 52)", async () => {
    const r = await run();
    writeFileSync(runPaths(r.dir).plan, "# P\nSetup: echo ready > ready.txt\n");
    writeFileSync(join(r.meta.repo, "ready.txt"), "x");
    const done = await runArchitectCheck(
      fakeDeps(),
      r,
      check("C1", "test -f ready.txt && echo '(fail) old'; exit 1"),
      opts,
    );
    expect(done).toMatchObject({ verdict: "inherited", preExisting: ["(fail) old"] });
  });

  it("leaves the verdict unknown when the base's Setup: fails, and the outer check still lands (plan 52)", async () => {
    const r = await run();
    writeFileSync(runPaths(r.dir).plan, "# P\nSetup: exit 3\n");
    const done = await runArchitectCheck(fakeDeps(), r, check("C1", "echo '(fail) old'; exit 1"), opts);
    expect(done).toMatchObject({ verdict: "unknown", exit: 1 });
  });

  it("keeps different files apart in the failing lines (plan 52)", async () => {
    const r = await run();
    const done = await runArchitectCheck(
      fakeDeps(),
      r,
      check("C1", `echo "(fail) $PWD/src/a.ts"; echo "(fail) $PWD/src/b.ts"; exit 1`, { scope: "fast" }),
      opts,
    );
    expect(done.failures).toEqual(["(fail) src/a.ts", "(fail) src/b.ts"]);
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
