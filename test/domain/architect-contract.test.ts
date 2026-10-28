import { describe, expect, it } from "bun:test";
import { composeBrief } from "../../src/domain/brief.ts";
import { roleContract } from "../../src/domain/role-prompts.ts";

const TOOLS = [
  "capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "thread_send",
  "thread_read",
  "thread_wait",
  "check",
  "ledger",
  "ask_owner",
  "finish",
];

describe("the architect loop's contract (plan 47, spec D1–D3 and the contract lines)", () => {
  it("names every tool and the architect's contract lines, and keeps the 2.0 architect's for a 2.0 run", () => {
    const loop = roleContract("architect", "2.0.0", "architect");
    for (const t of TOOLS) expect(loop).toContain(t);
    expect(loop).toContain("Handoffs are context, not proof");
    expect(loop).toContain("SKIP <task> — <evidence>");
    expect(loop).toContain("your recommendation first");
    expect(loop).not.toContain("lanes/Mx.Ly.md");
    expect(roleContract("architect", "2.0.0")).toContain("lanes/Mx.Ly.md");
    expect(roleContract("architect", "2.0.0", "2.0")).toBe(roleContract("architect", "2.0.0"));
  });

  it("makes a run the permission to test for the worker and the verifier", () => {
    for (const role of ["worker", "verifier"] as const)
      expect(roleContract(role, "2.0.0")).toContain("This run is your permission to test");
  });

  it("composes an architect run's brief with the loop's contract", () => {
    const parts = { facts: ["f"], unit: [], round: ["r"] };
    const c = {
      run: "r1",
      name: "architect-1",
      role: "architect" as const,
      version: "2.0.0",
      resumed: false,
      lane: null,
    };
    expect(composeBrief(parts, { ...c, engine: "architect" })).toContain("delegate_task");
    expect(composeBrief(parts, c)).not.toContain("delegate_task");
  });
});
