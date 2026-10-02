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
};

describe("what admission adds to a brief (spec 1.5 plan 21)", () => {
  it("inlines the lane file, header and body, then the role's notes, then its reply contract", () => {
    expect(composeBrief("Do lane M4.L1.", worker)).toBe(
      [
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
        "",
        replyContract("worker"),
        "",
      ].join("\n"),
    );
  });

  it("gives a role with no role server its CLI forms, and names no scratch where the backend grants none", () => {
    const text = composeBrief("Verify M1.", {
      run: RUN,
      name: "verifier-M1",
      role: "verifier",
      lane: null,
      scratch: null,
      roleServer: false,
    });
    expect(text).not.toContain("<lane-file");
    expect(text).not.toContain("scratch folder");
    expect(text).toContain(
      `Your catherd commands, from your shell: catherd run-file read ${RUN} <path>; catherd knowledge show; catherd gate check ${RUN} --milestone <M> --item <item> --command <command> --paths <path,…>; catherd gate pass ${RUN} --item <item> --command <command> --paths <path,…> --evidence <evidence>.`,
    );
    expect(text).toEndWith(`${replyContract("verifier")}\n`);
  });

  it("writes each part once when a failover stand-in reruns an earlier brief, with the lane file as it stands now", () => {
    const first = composeBrief("Do lane M4.L1.", worker);
    expect(composeBrief(first, worker)).toBe(first);
    const moved = {
      ...worker,
      lane: { id: "M4.L1", text: LANE.replace("Add the listing", "Add the paged listing") },
    };
    const again = composeBrief(first, moved);
    expect(again.match(/<lane-file /g)).toHaveLength(1);
    expect(again.match(/catherd: you are /g)).toHaveLength(1);
    expect(again).toContain("Add the paged listing endpoint.");
    expect(again).not.toContain("Add the listing endpoint.");
    expect(again).toBe(composeBrief("Do lane M4.L1.", moved));
  });
});
