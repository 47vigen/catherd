import { describe, expect, it } from "bun:test";
import { agentFiles, renderAgent } from "../../src/domain/agents.ts";
import {
  applyPatch,
  defaultProfileDoc,
  type ProfilePatch,
  resolveProfile,
} from "../../src/domain/profile.ts";
import { NATIVE_TOOL_PREFIX, rolePrompt } from "../../src/domain/role-prompts.ts";
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
      "You are a role of a catherd run, not its orchestrator. Never call catherd's peek, result, dispatch,",
    );
    for (const tool of ["peek", "result", "dispatch", "run_start", "land", "workspace_child_start"])
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

  it("gives the architect all five lane header lines the skill names", () => {
    const text = rolePrompt("architect", "1.0.0");
    expect(text).toContain("Its first five lines are exactly:");
    expect(text).toContain(
      [
        "    # Mx.Ly — <one line>",
        "    Owns: <repo-relative paths, comma-separated>",
        "    Fast check: <command>",
        "    Kind: repo_code|terminal|ui|prose|research",
        "    Difficulty: copy|build|logic|hard",
      ].join("\n"),
    );
    expect(text).not.toContain("first three lines");
  });

  it("puts the linter of every package the lane touches and the type check in the architect's fast check (plan 23)", () => {
    expect(rolePrompt("architect", "1.0.0")).toContain(
      "its targeted tests plus the linter of every package the lane touches (each package's own: golangci-lint for a Go module, its lint script for a JS one), and the type check when the project has one, scoped to those packages",
    );
  });

  it("has the architect translate a plan in hand instead of designing one", () => {
    const text = rolePrompt("architect", "1.0.0");
    expect(text).toContain("plan: <path>[, <path>…]");
    expect(text).toContain("Translate it, do not design");
    expect(text).toContain("decide only what the plan leaves undecided");
    expect(text).toContain("When the orchestrator sends you a design finding later");
  });
});
