import { describe, expect, it } from "bun:test";
import { BRIEF_PARTS, type BriefContext, composeBrief } from "../../src/domain/brief.ts";

const RUN = "20261002-101500-auth";
const LANE =
  "# M4.L1 — directory listing\nOwns: services/directory.go, services/internal_test.go\nFast check: go test ./services/...\nKind: repo_code\nDifficulty: build\n\nAdd the listing endpoint.\n";
const worker: BriefContext = {
  run: RUN,
  name: "worker-M4.L1",
  role: "worker",
  version: "0.0.0-test",
  resumed: false,
  lane: { id: "M4.L1", text: LANE },
};
const parts = { facts: ["f"], unit: ["u"], round: ["r"] };

/** The text between a part's tags. */
const part = (text: string, tag: string): string =>
  text.slice(text.indexOf(`<${tag}>\n`), text.indexOf(`</${tag}>`) + tag.length + 3);

describe("the brief in four parts", () => {
  it("a fresh brief is the four parts in order", () => {
    const text = composeBrief(parts, worker);
    const at = BRIEF_PARTS.map((t) => text.indexOf(`<${t}>\n`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(text).toStartWith("<role-contract>\n");
    expect(text).not.toContain("<team>");
    expect(text).not.toContain("mcp__");
  });

  it("holds the lane file at the end of the unit context and the role's notes at the end of the facts", () => {
    const text = composeBrief(parts, worker);
    const unit = part(text, "unit-context");
    expect(unit).toStartWith(
      "<unit-context>\nu\n\nYour lane file, lanes/M4.L1.md, as it stood when you were dispatched:",
    );
    expect(unit).toEndWith(`${LANE.trimEnd()}\n</lane-file>\n</unit-context>`);
    const facts = part(text, "run-facts");
    expect(facts).toStartWith("<run-facts>\nf\n\n");
    expect(facts).toContain(`catherd: you are worker-M4.L1 of run ${RUN}.`);
    expect(facts).toContain("Put temporary files in $TMPDIR, never in /tmp.");
    expect(facts).toContain(
      `Your catherd commands, from your shell: catherd run-file read ${RUN} <path>; catherd knowledge show; catherd team send ${RUN} --to <lane|role|all> (the message on stdin); catherd team read ${RUN} [--since <n>] [--limit <n>]; catherd call ${RUN} delegate_task (its arguments as JSON on stdin); catherd call ${RUN} task_status (its arguments as JSON on stdin); catherd call ${RUN} thread_wait (its arguments as JSON on stdin).`,
    );
    expect(part(text, "this-round")).toBe("<this-round>\nr\n</this-round>");
    expect(text).toEndWith("</this-round>\n");
  });

  it("gives a verifier no gate commands (plan 50) and no lane file without a lane", () => {
    const text = composeBrief(parts, { ...worker, name: "verifier-M1", role: "verifier", lane: null });
    expect(text).not.toContain("<lane-file");
    expect(part(text, "unit-context")).toBe("<unit-context>\nu\n</unit-context>");
    expect(text).not.toContain("catherd gate");
    expect(text).not.toContain("mcp__");
  });

  it("part 1 is byte-identical for a role", () => {
    const a = composeBrief(parts, worker);
    const b = composeBrief(
      { facts: ["other"], unit: ["x", "y"], round: ["z"] },
      {
        ...worker,
        run: "20261101-000000-other",
        name: "worker-M9.L3",
        lane: { id: "M9.L3", text: "# M9.L3\n" },
      },
    );
    expect(part(a, "role-contract")).toBe(part(b, "role-contract"));
    const verifier = composeBrief(parts, { ...worker, role: "verifier", lane: null });
    expect(part(verifier, "role-contract")).not.toBe(part(a, "role-contract"));
    expect(part(a, "role-contract")).toContain("at most 5 lines");
  });

  it("a resumed brief is this round and a pointer", () => {
    const text = composeBrief(parts, { ...worker, resumed: true });
    for (const t of BRIEF_PARTS.filter((t) => t !== "this-round")) expect(text).not.toContain(`<${t}>`);
    expect(text).toStartWith("<this-round>\nr\n");
    expect(text).toContain(`Your lane file is lanes/M4.L1.md (catherd run-file read ${RUN} lanes/M4.L1.md).`);
    expect(text).not.toContain("<lane-file");
    expect(text).toEndWith("</this-round>\n");
  });

  it("a resumed brief of a role with no lane has no pointer", () => {
    const text = composeBrief(parts, { ...worker, resumed: true, lane: null });
    expect(text).toBe("<this-round>\nr\n</this-round>\n");
  });
});
