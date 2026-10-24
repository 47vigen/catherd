import { describe, expect, it } from "bun:test";
import { type BriefContext, composeBrief } from "../../src/domain/brief.ts";
import { replyContract } from "../../src/domain/role-prompts.ts";

const RUN = "20261002-101500-auth";
const LANE =
  "# M4.L1 — directory listing\nOwns: services/directory.go, services/internal_test.go\nFast check: go test ./services/...\nKind: repo_code\nDifficulty: build\n\nAdd the listing endpoint.\n";
const worker: BriefContext = {
  run: RUN,
  name: "worker-M4.L1",
  role: "worker",
  lane: { id: "M4.L1", text: LANE },
  scratch: `/data/repos/app-1/runs/${RUN}/scratch/worker-M4.L1`,
  roleServer: true,
  version: "0.0.0-test",
  context: null,
  resumed: false,
};

describe("what admission adds to a brief (spec 1.5 plan 21)", () => {
  it("wraps the daemon's text, the lane file and the role's notes as the task, between the role's sections", () => {
    const text = composeBrief("Do lane M4.L1.", worker);
    expect(text).toStartWith("<role>\n");
    expect(text).toContain("<team>\n");
    expect(text).not.toContain("<context>");
    expect(text).toContain("bunx catherd-cli@0.0.0-test lock");
    expect(text).toContain(
      [
        "</team>",
        "",
        "<task>",
        "Do lane M4.L1.",
        "",
        "Your lane file, lanes/M4.L1.md, as it stood when you were dispatched:",
        '<lane-file path="lanes/M4.L1.md">',
        LANE.trimEnd(),
        "</lane-file>",
        "",
        `catherd: you are worker-M4.L1 of run ${RUN}.`,
        `Your scratch folder is /data/repos/app-1/runs/${RUN}/scratch/worker-M4.L1, which is your $TMPDIR: put temporary files, logs and builds there, never in /tmp. catherd removes it with the run, so anything the orchestrator must keep goes in your reply.`,
        `Your catherd tools: mcp__catherd_role__read_run_file, mcp__catherd_role__read_knowledge. If they are not listed, run the same from your shell: catherd run-file read ${RUN} <path>; catherd knowledge show.`,
        "</task>",
        "",
        "<done_when>",
        "",
      ].join("\n"),
    );
    expect(text).toEndWith(`<reply_contract>\n${replyContract("worker")}\n</reply_contract>\n`);
  });

  it("puts the plan's preamble before the role when one is given", () => {
    const text = composeBrief("x", { ...worker, context: "The plan's preamble (p.md)…" });
    expect(text).toStartWith("<context>\nThe plan's preamble (p.md)…\n</context>\n\n<role>\n");
  });

  it("the context comes first", () => {
    const text = composeBrief("x", { ...worker, context: "ctx" });
    expect(text.indexOf("<context>")).toBeLessThan(text.indexOf("<role>"));
  });

  it("a resumed brief carries only the task and the reply contract", () => {
    const text = composeBrief("x", { ...worker, context: "ctx", resumed: true });
    for (const t of ["role", "team", "context", "done_when"]) expect(text).not.toContain(`<${t}>`);
    expect(text).toStartWith("<task>\n");
    expect(text).toEndWith(`<reply_contract>\n${replyContract("worker")}\n</reply_contract>\n`);
  });

  it("gives a role with no role server its CLI forms, and names no scratch where the backend grants none", () => {
    const text = composeBrief("Verify M1.", {
      run: RUN,
      name: "verifier-M1",
      role: "verifier",
      lane: null,
      scratch: null,
      roleServer: false,
      version: "0.0.0-test",
      context: null,
      resumed: false,
    });
    expect(text).not.toContain("<lane-file");
    expect(text).not.toContain("scratch folder");
    expect(text).toContain(
      `Your catherd commands, from your shell: catherd run-file read ${RUN} <path>; catherd knowledge show; catherd gate check ${RUN} --milestone <M> --item <item> --command <command> --paths <path,…>; catherd gate pass ${RUN} --milestone <M> --item <item> --command <command> --paths <path,…> --evidence <evidence>; catherd gate run ${RUN} --milestone <M> --command <command> [--at <base checkout>].`,
    );
    expect(text).toEndWith(`<reply_contract>\n${replyContract("verifier")}\n</reply_contract>\n`);
  });

  it("writes each part once when a failover stand-in reruns an earlier brief, with the lane file as it stands now", () => {
    const first = composeBrief("Do lane M4.L1.", worker);
    expect(composeBrief(first, worker)).toBe(first);
    const moved = {
      ...worker,
      lane: { id: "M4.L1", text: LANE.replace("Add the listing", "Add the paged listing") },
    };
    const again = composeBrief(first, moved);
    expect(again.match(/<role>/g)).toHaveLength(1);
    expect(again.match(/<task>\n/g)).toHaveLength(1);
    expect(again.match(/<lane-file /g)).toHaveLength(1);
    expect(again.match(/catherd: you are /g)).toHaveLength(1);
    expect(again).toContain("Add the paged listing endpoint.");
    expect(again).not.toContain("Add the listing endpoint.");
    expect(again).toBe(composeBrief("Do lane M4.L1.", moved));
  });
});
