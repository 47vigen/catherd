import { describe, expect, it } from "bun:test";
import { agentFiles, renderAgent } from "../../src/domain/agents.ts";
import {
  applyPatch,
  defaultProfileDoc,
  type ProfilePatch,
  resolveProfile,
} from "../../src/domain/profile.ts";
import { rolePrompt } from "../../src/domain/role-prompts.ts";

const profile = (patch: ProfilePatch = {}, name = "default") =>
  resolveProfile(applyPatch(defaultProfileDoc(name), patch), name);

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
        "disallowedTools: Write, Edit, NotebookEdit, Agent",
        "---",
        "",
        "You are the architect of a catherd run.",
      ].join("\n"),
    );
  });

  it("takes the tool list from the role's access, not from the role", () => {
    const [verifier] = agentFiles(profile({ roles: { architect: { enabled: false } } }), "1.0.0");
    expect(verifier?.text).toContain("\ndisallowedTools: Agent\n");
    const [ro] = agentFiles(
      profile({ roles: { architect: { enabled: false }, verifier: { access: "read-only" } } }),
      "1.0.0",
    );
    expect(ro?.text).toContain("\ndisallowedTools: Write, Edit, NotebookEdit, Agent\n");
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

  it("leaves the effort out for a model that takes none", () => {
    const text = renderAgent({
      profile: "p",
      role: "verifier",
      rung: "claude:claude-haiku-4-5-20251001#default",
      access: "full",
      version: "1.0.0",
    });
    expect(text).toContain("\nmodel: claude-haiku-4-5-20251001\ndisallowedTools: Agent\n");
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
});
