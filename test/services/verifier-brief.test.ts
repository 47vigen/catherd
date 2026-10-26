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
import { issueTitle } from "../../src/services/brief-cap.ts";
import { renderBrief } from "../../src/services/run-briefs.ts";
import { milestoneOfName, verifierBrief } from "../../src/services/verifier-brief.ts";
import { runningLog } from "../domain/run-fixtures.ts";
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

  it("tells a verifier with no Check to run the full check through gate_run on the committed HEAD", () => {
    const rules = VERIFIER_GATE_RULES.join("\n");
    expect(rules).toContain("gate_run");
    expect(rules).toContain("gate_run (or catherd gate run) is only for a milestone with no Check line");
    expect(rules).toContain("committed HEAD");
    expect(rules).toContain("every top-level `&&` part as its own item");
    expect(rules).toContain("gate_pass with the same milestone");
  });

  it("splits the root gate from acceptance, keeps acceptance from HEAD, says BLOCKED, and prunes images", () => {
    const rules = VERIFIER_GATE_RULES.join("\n");
    expect(rules).toContain("each per-service acceptance suite as its own item");
    expect(rules).toContain("Acceptance that builds from HEAD (git archive, a commit's image) is yours");
    expect(rules).toContain("twice, 5 s apart");
    expect(rules).toContain("docker image prune -f");
    // the native verifier's agent file carries the same rules
    expect(rolePrompt("verifier", "1.0.0")).toContain(rules);
    expect(gateNotes({ milestone: null, recorded: [], env: [] })).toBe("");
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
    const { repo, run } = freshRun();
    await setGateEnv(repo, "DOCKER_HOST", { value: "unix:///tmp/d.sock" });
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
    expect(text).toContain(`\n\n${replyContract("verifier")}\n</role-contract>`);
  });

  it("the gate rules appear once", async () => {
    const { repo, run } = freshRun();
    await setGateEnv(repo, "DOCKER_HOST", { value: "unix:///tmp/d.sock" });
    const brief = await verifierBrief(run, "verifier", "verifier-M1", "Verify M1.");
    expect(brief).toContain(GATE_NOTES_HEADING);
    const first = VERIFIER_GATE_RULES[0] as string;
    expect(`${rolePrompt("verifier", "1.0.0")}\n\n${brief}`.split(first)).toHaveLength(2);
  });
});

describe("the composed verifier brief (plan 44)", () => {
  const verify = {
    type: "dispatch" as const,
    unit: "M1",
    name: "verifier-M1",
    role: "verifier" as const,
    lane: null,
    rung: null,
    thread: null,
    failoverFrom: null,
    brief: "verify" as const,
    notes: [],
  };

  it("known issues are titles", async () => {
    const { run } = freshRun();
    const issue = `A8 red-first: accepted by the owner\n${"second line of the reason ".repeat(20)}\nthird line ${"z".repeat(300)}`;
    expect(issue.split("\n")).toHaveLength(3);
    expect(issue.length).toBeGreaterThan(800);
    expect(issueTitle(issue)).toBe("A8 red-first: accepted by the owner");
    const s = runningLog().state();
    (s.milestones.find((m) => m.id === "M1") as { knownIssues: string[] }).knownIssues = [issue];
    const text = await renderBrief(run, s, verify, false);
    expect(text).toContain("- A8 red-first: accepted by the owner\n");
    expect(text).toContain("the milestone's digest");
    expect(text).not.toContain("second line of the reason");
    expect(text).not.toContain("third line");
  });

  it("carries the gate notes at the end of this round, once", async () => {
    const { repo, run } = freshRun();
    await setGateEnv(repo, "DOCKER_HOST", { value: "unix:///tmp/d.sock" });
    const text = await renderBrief(run, runningLog().state(), verify, false);
    expect(text.indexOf(GATE_NOTES_HEADING)).toBeGreaterThan(text.indexOf("<this-round>"));
    expect(text.split(GATE_NOTES_HEADING)).toHaveLength(2);
    expect(text).toContain("DOCKER_HOST=unix:///tmp/d.sock");
    // a resumed thread gets the notes too: the gate environment can change between rounds
    expect(await renderBrief(run, runningLog().state(), verify, true)).toContain(GATE_NOTES_HEADING);
  });

  it("a verifier brief lists the commands to run", async () => {
    const { run } = freshRun();
    writeFileSync(join(run.dir, "plan.md"), "# P\n\n## M1 — core\n- A1 [run] it works\nCheck: bun test\n");
    const s = runningLog().state();
    const m = s.milestones.find((x) => x.id === "M1") as { commit: string | null; checkedOn: string | null };
    m.commit = "abc123def456abc";
    m.checkedOn = null;
    const open = await renderBrief(run, s, verify, false);
    expect(open).toContain("\nRUN: bun test\n");
    expect(open).toContain("RAN: <command> — exit <n> — <log path>");
    m.checkedOn = m.commit;
    expect(await renderBrief(run, s, verify, false)).not.toContain("RUN: bun test");
  });
});
