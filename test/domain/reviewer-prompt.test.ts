import { describe, expect, it } from "bun:test";
import { roleContract, rolePrompt } from "../../src/domain/role-prompts.ts";

describe("the reviewer contract (plan 51, spec D8)", () => {
  const text = rolePrompt("reviewer", "2.0.0");

  it("reports on the important, nit and pre-existing scale, each finding with its bug class", () => {
    expect(text).toContain("IMPORTANT|NIT|PRE-EXISTING (<bug class>) file:line");
    expect(text).toContain("It never starts a fix round");
    expect(text).toContain("An IMPORTANT finding needs that input");
  });

  it("names no milestone, lane or Owns, and re-reviews only the diff it is given", () => {
    for (const word of ["milestone", "lane", "Owns", "BLOCKER"]) expect(text).not.toContain(word);
    expect(text).toContain("never report an earlier finding again");
    expect(text).toContain("after two replies on it, the architect decides");
  });

  it("takes over the ui-reviewer's screenshots when the brief names screens", () => {
    expect(text).toContain("When your brief names screens (a UI pass)");
    expect(text).toContain("agent-browser screenshot <path>");
  });

  it("tells the architect when to review and how deep, and to log each finding's handling", () => {
    const architect = rolePrompt("architect", "2.0.0");
    expect(architect).toContain("after three review rounds on one task, replan it");
    expect(architect).toContain("money, auth, migrations or CI");
    expect(architect).toContain("- findings {taskId?, handled?, missed?, why}");
  });

  it("names writer trees and merges to the architect of a trees: writer run only, so a shared run reads stage 1's (plan 55)", () => {
    const writer = roleContract("architect", "2.0.0", "writer");
    const shared = roleContract("architect", "2.0.0", "shared");
    expect(writer).toContain("- merge {taskId, why}");
    expect(writer).toContain("worktree?, from?");
    expect(shared).not.toContain("- merge {taskId, why}");
    expect(shared).not.toMatch(/worktree|its own tree/);
    expect(shared).toContain("- delegate_task {role, task, rung?, ledgerTask?, why}");
    expect(shared).toContain("- oracle_accept {taskId, why}");
    expect(roleContract("worker", "2.0.0", "shared")).toBe(roleContract("worker", "2.0.0", "writer"));
  });
});
