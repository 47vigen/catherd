import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_NOTES_HEADING, gateNotes, VERIFIER_GATE_RULES } from "../../src/domain/gate-brief.ts";
import { replyContract, rolePrompt } from "../../src/domain/role-prompts.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { admit } from "../../src/services/admission.ts";
import { setGateEnv } from "../../src/services/gate-env.ts";
import { gateCheck, gatePass } from "../../src/services/gate-service.ts";
import { milestoneOfName, verifierBrief } from "../../src/services/verifier-brief.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, freshRun, testView } from "./helpers.ts";

afterEach(snapshotEnv());

describe("the verifier's brief (plan 23)", () => {
  it("names the milestone a verifier checks from its name", () => {
    expect(milestoneOfName("verifier-M1")).toBe("M1");
    expect(milestoneOfName("verifier-M12-recheck")).toBe("M12");
    expect(milestoneOfName("verifier-M1fix")).toBeNull();
    expect(milestoneOfName("verifier")).toBeNull();
  });

  it("splits the root gate from acceptance, keeps acceptance from HEAD, says BLOCKED, and prunes images", () => {
    const rules = VERIFIER_GATE_RULES.join("\n");
    expect(rules).toContain("each per-service acceptance suite as its own item");
    expect(rules).toContain("Acceptance that builds from HEAD (git archive, a commit's image) is yours");
    expect(rules).toContain("twice, 5 s apart");
    expect(rules).toContain("docker image prune -f");
    // the native verifier's agent file carries the same rules
    expect(rolePrompt("verifier", "1.0.0")).toContain(rules);
    expect(gateNotes({ milestone: null, recorded: [], env: [] })).toBe(
      [GATE_NOTES_HEADING, "", ...VERIFIER_GATE_RULES.map((r) => `- ${r}`)].join("\n"),
    );
  });

  it("adds the recorded items, the failed ones to re-check first with a cap, and the gate env, once", async () => {
    const { repo, run } = freshRun();
    writeFileSync(join(repo, "a.ts"), "a");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"], { cwd: repo });
    const deps = fakeDeps();
    const check = (item: string) => ({ run: run.id, item, command: item, paths: ["."], milestone: "M1" });
    await gateCheck(deps, check("lint"));
    await gatePass(deps, { ...check("lint"), evidence: "ok" });
    await gateCheck(deps, check("acceptance notification"));
    await setGateEnv(repo, "DOCKER_HOST", { value: "unix:///tmp/d.sock" });
    const brief = await verifierBrief(run, "verifier", "verifier-M1", "Verify M1.");
    expect(brief).toStartWith(`Verify M1.\n\n${GATE_NOTES_HEADING}\n`);
    expect(brief).toContain(
      "- Items already recorded for M1; reuse these names in gate_check, so what passed is carried over: lint, acceptance notification.",
    );
    expect(brief).toContain(
      "- This is a re-check. Run the failed items first: acceptance notification. Cap each command at 10 minutes;",
    );
    expect(brief).toContain("DOCKER_HOST=unix:///tmp/d.sock");
    expect(await verifierBrief(run, "verifier", "verifier-M1", brief)).toBe(brief);
    expect(await verifierBrief(run, "reviewer", "reviewer-M1", "Review M1.")).toBe("Review M1.");
  });

  it("is what dispatch writes for a verifier, before its reply contract", async () => {
    const { run } = freshRun();
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({ reply: "VERDICT: PASS" }).env);
    const view = testView();
    view.roles.verifier = { enabled: true, access: "full", rungs: ["codex:gpt-6-sol#high"] };
    const { d } = await admit(fakeDeps({ view }), run, {
      role: "verifier",
      name: "verifier-M1",
      brief: "Verify M1.",
      rung: "codex:gpt-6-sol#high",
      thread: null,
      lane: null,
      failoverFrom: null,
    });
    const text = readFileSync(dispatchPaths(d.dir).brief, "utf8");
    expect(text).toContain(GATE_NOTES_HEADING);
    expect(text).toEndWith(`\n\n${replyContract("verifier")}\n`);
  });
});
