import { describe, expect, it } from "bun:test";
import { rolePrompt } from "../../src/domain/role-prompts.ts";

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

  it("tells the architect when to review and how deep, and to log each finding's handling", () => {
    const architect = rolePrompt("architect", "2.0.0");
    expect(architect).toContain("after three review rounds on one task, replan it");
    expect(architect).toContain("money, auth, migrations or CI");
    expect(architect).toContain("- findings {taskId?, handled?, missed?, why}");
  });
});
