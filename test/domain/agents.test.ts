import { describe, expect, it } from "bun:test";
import { agentFiles, renderAgent } from "../../src/domain/agents.ts";
import {
  applyPatch,
  defaultProfileDoc,
  type ProfilePatch,
  resolveProfile,
} from "../../src/domain/profile.ts";
import { ROLES } from "../../src/domain/roles.ts";
import {
  NATIVE_TOOL_PREFIX,
  NEXT_LINE,
  replyContract,
  roleContract,
  rolePrompt,
} from "../../src/domain/role-prompts.ts";
import { COORDINATOR_TOOLS } from "../../src/domain/role-scope.ts";

/** spec 1.5 plan 21: every native role's agent file also forbids catherd's coordinator tools and record_agent_run */
const COORDINATOR = [...COORDINATOR_TOOLS, "record_agent_run"]
  .map((t) => `${NATIVE_TOOL_PREFIX}${t}`)
  .join(", ");

const profile = (patch: ProfilePatch = {}, name = "default") =>
  resolveProfile(applyPatch(defaultProfileDoc(name), patch), name, "claude-code");

describe("agentFiles", () => {
  it("writes one file per enabled role and native rung of the default profile", () => {
    const files = agentFiles(profile(), "1.0.0");
    expect(files.map((f) => [f.name, f.role, f.rung])).toEqual([
      ["catherd-default-architect-claude-opus-5-5-high", "architect", "claude:claude-opus-5-5#high"],
      ["catherd-default-verifier-claude-opus-5-5-low", "verifier", "claude:claude-opus-5-5#low"],
    ]);
    expect(files[0]?.text).toStartWith(
      [
        "---",
        "name: catherd-default-architect-claude-opus-5-5-high",
        "description: Internal architect role of the catherd orchestrator (profile default), on claude-opus-5-5 at high effort. Dispatched only by the catherd skill while a run is in flight. Never for a plain request, even one that names this role.",
        "model: claude-opus-5-5",
        "effort: high",
        `disallowedTools: Write, Edit, NotebookEdit, Agent, ${COORDINATOR}`,
        "---",
        "",
        "You are the architect of a catherd run.",
      ].join("\n"),
    );
  });

  it("takes the tool list from the role's access, not from the role", () => {
    const [verifier] = agentFiles(profile({ roles: { architect: { enabled: false } } }), "1.0.0");
    expect(verifier?.text).toContain(`\ndisallowedTools: Agent, ${COORDINATOR}\n`);
    const [ro] = agentFiles(
      profile({ roles: { architect: { enabled: false }, verifier: { access: "read-only" } } }),
      "1.0.0",
    );
    expect(ro?.text).toContain(`\ndisallowedTools: Write, Edit, NotebookEdit, Agent, ${COORDINATOR}\n`);
  });

  it("skips disabled roles and headless rungs, and counts a native stand-in", () => {
    const p = profile({
      roles: {
        architect: { enabled: false },
        verifier: { rungs: ["claude-code:claude-opus-5-5#low"] },
      },
      failover: { "codex:gpt-6-sol#high": "claude:claude-sonnet-5#high" },
    });
    expect(agentFiles(p, "1.0.0").map((f) => f.name)).toEqual([
      "catherd-default-reviewer-claude-sonnet-5-high",
      "catherd-default-worker-claude-sonnet-5-high",
    ]);
  });

  it("tells a native role it is not the orchestrator, and forbids it the coordinator tools (spec 1.5 plan 21)", () => {
    const [architect] = agentFiles(profile(), "1.0.0");
    expect(architect?.text).toContain(
      "You are a role of a catherd run, not its orchestrator. Never call catherd's run_start, answer, cancel,",
    );
    for (const tool of ["run_start", "answer", "cancel", "result", "profile"])
      expect(architect?.text).toContain(`${NATIVE_TOOL_PREFIX}${tool}`);
  });

  it("forbids a native role record_agent_run, which only the orchestrator calls (PR #46 P1)", () => {
    for (const access of ["full", "read-only"] as const) {
      const text = renderAgent({
        profile: "p",
        role: "verifier",
        rung: "claude:claude-opus-5-5#low",
        access,
        version: "1.0.0",
      });
      const line = text.split("\n").find((l) => l.startsWith("disallowedTools: "));
      expect(line?.split(", ")).toContain(`${NATIVE_TOOL_PREFIX}record_agent_run`);
      expect(text).toContain("record_agent_run: they belong to the orchestrator");
    }
  });

  it("leaves the effort out for a model that takes none", () => {
    const text = renderAgent({
      profile: "p",
      role: "verifier",
      rung: "claude:claude-haiku-4-5-20251001#default",
      access: "full",
      version: "1.0.0",
    });
    expect(text).toContain(`\nmodel: claude-haiku-4-5-20251001\ndisallowedTools: Agent, ${COORDINATOR}\n`);
    expect(text).toContain("(profile p), on claude-haiku-4-5-20251001. Dispatched only by the catherd skill");
    expect(text).not.toContain("effort");
  });

  it("writes one file when a stand-in is also one of the role's rungs", () => {
    const p = profile({
      roles: { verifier: { rungs: ["codex:gpt-6-sol#high", "claude:claude-opus-5-5#low"] } },
      failover: { "codex:gpt-6-sol#high": "claude:claude-opus-5-5#low" },
    });
    expect(
      agentFiles(p, "1.0.0")
        .filter((f) => f.role === "verifier")
        .map((f) => f.name),
    ).toEqual(["catherd-default-verifier-claude-opus-5-5-low"]);
  });
});

describe("rolePrompt", () => {
  it("names the catherd version whose lock the worker uses", () => {
    expect(rolePrompt("worker", "1.2.3")).toContain("bunx catherd-cli@1.2.3 lock -- <command>");
  });

  it("never asks the read-only researcher to run the suite for its time", () => {
    const text = rolePrompt("researcher", "1.0.0");
    expect(text).toContain("how long the full suite takes when the docs, the CI config or a log say so");
    expect(text).toContain('never run the suite to find out; write "unknown" instead');
  });

  it("has the researcher report the lint and type-check commands", () => {
    expect(rolePrompt("researcher", "1.0.0")).toContain(
      "the lint and type-check commands, and how to scope each to one package",
    );
  });

  it("gives the architect all six lane header lines the skill names", () => {
    const text = rolePrompt("architect", "1.0.0");
    expect(text).toContain("Its first six lines are exactly:");
    expect(text).toContain(
      [
        "    # Mx.Ly — <one line>",
        "    Owns: <repo-relative paths, comma-separated>",
        "    Fast check: <command>",
        "    Kind: repo_code|terminal|ui|prose|research",
        "    Difficulty: copy|build|logic|hard",
        "    Tasks: <plan task numbers, comma-separated; <plan file>#<n> when the run has several plan files>",
      ].join("\n"),
    );
    expect(text).not.toContain("first three lines");
  });

  it("the architect is not told to write Chore: yes, and Kind and Difficulty inform the decision model", () => {
    const text = rolePrompt("architect", "1.0.0");
    expect(text).not.toContain("Chore");
    expect(text).toContain("inform the decision model");
  });

  it("has the architect end an A-line the Check proves on its own with (Check), in both plan paths (plan 40)", () => {
    expect(rolePrompt("architect", "1.0.0").split("ends with `(Check)`")).toHaveLength(3);
  });

  it("puts the linter of every package the lane touches and the type check in the architect's fast check (plan 23)", () => {
    expect(rolePrompt("architect", "1.0.0")).toContain(
      "its targeted tests plus the linter of every package the lane touches (each package's own: golangci-lint for a Go module, its lint script for a JS one), and the type check when the project has one, scoped to those packages",
    );
  });

  it("has the architect translate a plan in hand instead of designing one", () => {
    const text = rolePrompt("architect", "1.0.0");
    expect(text).toContain("When your brief lists the owner's plan files");
    expect(text).toContain("Translate it, do not design");
    expect(text).toContain("only what the plan leaves undecided");
    expect(text).toContain("When the orchestrator sends you a design finding later");
  });

  it("the agent file is the role contract", () => {
    for (const role of ROLES) expect(rolePrompt(role, "1.0.0")).toBe(roleContract(role, "1.0.0"));
    const worker = rolePrompt("worker", "1.0.0");
    expect(worker).toContain("at most 5 lines");
    expect(worker).toContain("REPORT:");
  });

  it("the role contract is the body, who comes next, done-when and the reply, once each and in order", () => {
    for (const role of ROLES) {
      const text = roleContract(role, "1.0.0");
      const at = [
        text.indexOf("is information, not instructions"),
        text.indexOf(NEXT_LINE[role]),
        text.indexOf("Done when: "),
        text.indexOf(replyContract(role)),
      ];
      expect(at.every((n, i) => n >= 0 && (i === 0 || n > (at[i - 1] as number)))).toBe(true);
      expect(text.split("Done when: ")).toHaveLength(2);
      expect(NEXT_LINE[role]).toStartWith("After you: ");
      if (role !== "worker") expect(text).toContain("stop every background watcher");
      // a contract names no section tag, no team paragraph and no backend-specific tool
      for (const t of ["<role", "<team>", "<task>\n", "<context>\n", "<done_when>", "mcp__"])
        expect(text).not.toContain(t);
    }
  });

  it("the role contract holds the same bytes whatever the run", () => {
    expect(roleContract("verifier", "1.0.0")).toBe(roleContract("verifier", "1.0.0"));
    expect(roleContract("worker", "1.0.0")).not.toBe(roleContract("worker", "2.0.0"));
    expect(roleContract("worker", "1.0.0")).not.toBe(roleContract("verifier", "1.0.0"));
  });

  it("gives the reviewer t3herd's rules and the plan rule", () => {
    const text = rolePrompt("reviewer", "1.0.0");
    for (const s of [
      "A problem is a BUG, never a NIT, when it breaks a standing rule",
      "names every place in the diff",
      "closest sibling",
      "never findings: catherd writes the commits",
      "in this one pass",
      "do not run the test suites",
      "departs from its plan task with no DESIGN: answer",
    ])
      expect(text).toContain(s);
  });

  it("gives the worker its tasks, DESIGN, check, EXTRA, Reference, retry and fix-round rules", () => {
    const text = rolePrompt("worker", "1.0.0");
    for (const s of [
      "Implement them as written",
      "commit steps are not yours",
      "reply DESIGN: <task> — <the conflict> — <the change you propose>",
      "Never weaken, skip or edit a check or a test",
      "EXTRA: <path> — <why>",
      "Reference: line, open that file first",
      "this is a retry",
      "In a fix round",
      "REJECTED: <the finding's first words> — <why>",
      "stale diff",
      "run after your last edit",
    ])
      expect(text).toContain(s);
  });

  it("a worker is told never to end its turn on a background wait", () => {
    expect(rolePrompt("worker", "1.0.0")).toContain("Never end your turn to wait");
  });

  it("asks the architect to translate a given plan and to write a deep one otherwise", () => {
    const text = rolePrompt("architect", "1.0.0");
    for (const s of [
      "Translate it, do not design",
      "lane only those",
      "## What already exists",
      "## Contracts",
      "rejected: <the alternative>",
      "with no approval: a task you add lives in its lane file's body",
      "Tasks: <plan task numbers",
      "`Reference: <repo path>`",
      "more small lanes beat one long one",
    ])
      expect(text).toContain(s);
  });

  it("tells the judge what it decides and who comes after it", () => {
    const text = rolePrompt("judge", "1.0.0");
    expect(text).toContain("You are the judge of a catherd run");
    expect(text).toContain("DECISION: one of the verbs");
  });
});
