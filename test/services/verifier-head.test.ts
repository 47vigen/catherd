import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDispatch, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };

describe("the verifier's HEAD line is checked against the tree (plan 50, spec D11 R5)", () => {
  async function headOf(role: "verifier" | "reviewer", line: (real: string) => string, dirty = false) {
    const { repo, run } = freshRun();
    const real = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    if (dirty) writeFileSync(join(repo, "left-over.txt"), "x\n");
    const d = await fakeDispatch(
      run,
      { role, lane: null, name: "T9" },
      { exit, events: "", reply: `VERDICT: PASS\n${line(real)}\nSTATUS: complete — ok\n` },
    );
    return { head: (await finalizeDispatch(run, d)).head, real };
  }

  it("keeps a head that is a prefix of the real HEAD on a clean tree", async () => {
    const r = await headOf("verifier", (real) => `HEAD: ${real.slice(0, 10)}`);
    expect(r.head).toBe(r.real.slice(0, 10));
  });

  it("drops a head that names another commit", async () => {
    expect((await headOf("verifier", () => "HEAD: abc1234")).head).toBeUndefined();
  });

  it("drops a head when the tree is dirty", async () => {
    expect((await headOf("verifier", (real) => `HEAD: ${real}`, true)).head).toBeUndefined();
  });

  it("leaves other roles' head lines alone", async () => {
    expect((await headOf("reviewer", () => "HEAD: abc1234")).head).toBe("abc1234");
  });
});
