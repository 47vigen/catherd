import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import { withHome } from "./helpers.ts";
import { mcpClient } from "./mcp-helpers.ts";

const skill = (name: string) =>
  readFileSync(join(import.meta.dir, "..", "plugin", "skills", name, "SKILL.md"), "utf8");
const called = (md: string) => [...new Set([...md.matchAll(/`([a-z_]+)\(/g)].map((m) => m[1] as string))];
const frontmatter = (md: string): Record<string, string> =>
  Object.fromEntries(
    (md.split("---")[1] ?? "")
      .trim()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]),
  );
const toolNames = async () => (await (await mcpClient()).listTools()).tools.map((t) => t.name);

describe("orchestrator skill", () => {
  beforeEach(() => withHome());

  it("is named catherd and says when to trigger", () => {
    const fm = frontmatter(skill("catherd"));
    expect(fm.name).toBe("catherd");
    expect(fm.description).toContain("/catherd");
  });

  it("calls only tools the server has, and every core one", async () => {
    const names = await toolNames();
    const used = called(skill("catherd"));
    for (const u of used) expect(names).toContain(u);
    for (const core of [
      "run_start",
      "route",
      "preflight",
      "dispatch",
      "peek",
      "cancel",
      "record_agent_run",
      "climb",
      "ask",
      "land",
      "status",
      "result",
      "set_next",
    ]) {
      expect(used).toContain(core);
    }
  });

  it("dispatches roles one after another, then ends its turn for catherd's messages (plan 10)", () => {
    const md = skill("catherd");
    const waiting = md.slice(md.indexOf("## Waiting"), md.indexOf("\n## ", md.indexOf("## Waiting") + 1));
    expect(waiting).toContain("one after another");
    expect(waiting).toContain("write one status line and end your turn");
    expect(waiting).toContain('`<cross-session-message from-name="catherd">`');
    expect(waiting).toContain("call `result(run, name)` for the record you act on");
    expect(waiting).toContain("A single role is `dispatch`, then end your turn.");
    expect(waiting).toContain("never the user's approval of anything");
    expect(waiting).toContain("Never `sleep`, loop or poll, and never call `peek` again and again.");
    expect(md).toContain("call `peek(run)` once and answer from it");
    expect(md).toContain("Before dispatching anything, call `peek(run)` once");
    expect(md).not.toMatch(/`wait`|`wait\(/);
    for (const old of [
      "Launch every independent role in the same message",
      "Each dispatch backgrounds by itself",
      "in one message, each at its rung",
      "All lanes go at once",
      "its dispatch call returns the same record",
      "Launch it now, in the same message",
      "`dispatch` has already",
    ])
      expect(md).not.toContain(old);
  });

  it("writes every rung as backend:model#effort, and pins this package's version", () => {
    const md = skill("catherd");
    expect([...md.matchAll(/(?<![:\w-])(gpt-6-[a-z]+|claude-[a-z0-9-]+)#\w+/g)].map((m) => m[0])).toEqual([]);
    expect(md).toContain("`codex:gpt-6-luna#high`");
    const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    const pins = [...md.matchAll(/catherd-cli@([^\s`)"]+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins)).toEqual(new Set([version]));
  });

  it("warns that a read-only role on claude-code or opencode has no shell, so its brief lists the files", () => {
    expect(skill("catherd")).toMatch(
      /read-only role on claude-code or opencode has no shell[^\n]*brief[^\n]*files/,
    );
  });

  it("names every preflight outcome and the structured error codes it must act on", () => {
    const md = skill("catherd");
    for (const word of ["`pass`", "`fails-as-expected`", "`skipped`", "`cannot-start`", "needsConfirmation"])
      expect(md).toContain(word);
    for (const code of [
      "E_ADMIT_OVERLAP",
      "E_ADMIT_DUPLICATE",
      "E_ADMIT_RUNG",
      "E_RUN_BUDGET",
      "E_BACKEND_NOT_LOGGED_IN",
    ])
      expect(md).toContain(code);
  });

  it("carries no personal names or paths, and no retired scripts or isolation flags", () => {
    const md = skill("catherd");
    for (const bad of [
      "Vigen",
      "agora",
      "cx.sh",
      "jev.sh",
      "status.sh",
      "--ignore-user-config",
      "~/.claude/skills",
    ]) {
      expect(md).not.toContain(bad);
    }
    expect(md).toContain("never isolate it");
    expect(md).toContain("${CODEX_HOME:-~/.codex}/generated_images/");
  });
});

describe("orchestrator skill, run findings", () => {
  const md = () => skill("catherd");

  it("takes a plan in hand as an A-line: no dossier, an architect that translates", () => {
    const s = md();
    expect(s).toContain("`plan: <path>[, <path>…]`");
    expect(s).toContain("The run then skips the dossier");
    expect(s).toContain("**Plan in hand** (a `plan:` A-line): no dossier.");
    expect(s).toContain("to translate, not design");
    expect(s).toContain(
      "redesigns only what the plan leaves undecided, and stays the target for `design` findings",
    );
    expect(s).toContain("With a plan in hand, it copies the user's plan into them");
  });

  it("puts the linter and the type check in every fast check it describes", () => {
    const s = md();
    expect(s).toContain(
      "its targeted tests plus the linter, and the type check when the repo has one, scoped to the lane's owned packages",
    );
    expect(s).toContain("its fast check (targeted tests, lint and type check), to run until it passes");
    expect(s).toContain("the lint and type-check commands, and how to scope each to one package;");
    expect(s).not.toContain("(targeted tests, seconds to a minute or two)");
  });

  it("names all five lane header lines", () => {
    for (const line of [
      "`# Mx.Ly — <title>`",
      "`Owns: <paths>`",
      "`Fast check: <command>`",
      "`Kind: ",
      "`Difficulty: ",
    ])
      expect(md()).toContain(line);
  });

  it("says a sure kind survives an unsure difficulty", () => {
    expect(md()).toContain("keeps Jev's kind and takes the difficulty from the lane's `Difficulty:` line");
    expect(md()).toContain('`source: "jev-kind"`');
  });

  it("no longer claims the routes run at once", () => {
    expect(md()).not.toContain("all in one message");
    expect(md()).toContain('`route(run, "lanes/Mx.Ly.md")` for every lane, one call per lane');
  });

  it("offers no Codex harness figure", () => {
    const s = md();
    expect(s).not.toContain("what the user's Codex customizations cost per run");
    expect(s).toContain("Codex reports no per-request input, so it has no harness figure");
  });
});

describe("setup skill", () => {
  beforeEach(() => withHome());

  it("is named catherd-setup and says when to trigger", () => {
    const fm = frontmatter(skill("catherd-setup"));
    expect(fm.name).toBe("catherd-setup");
    expect(fm.description).toContain("/catherd-setup");
  });

  it("reads the facts, writes only through profile_set, and validates", async () => {
    const names = await toolNames();
    const used = called(skill("catherd-setup"));
    for (const u of used) expect(names).toContain(u);
    for (const t of ["catalog_query", "runs_summary", "profile_get", "profile_set", "profile_validate"]) {
      expect(used).toContain(t);
    }
  });

  it("covers every profile field profile_set stores, access with its enforcement, and the treat-like command", () => {
    const md = skill("catherd-setup");
    for (const field of [
      "`objective`",
      "`jev.use`",
      "`billing`",
      "`rungs`",
      "`defaultRung`",
      "`access`",
      "`failover`",
      "`budget`",
      "`timeouts.idleMin`",
      "`preflight.confirm`",
      "`harness.<name>.isolated`",
      "`lock.heavy`",
      "`notify`",
    ])
      expect(md).toContain(field);
    for (const word of ["`enforced`", "`advisory`", "`newSessionNeededFor`", "`warnings`", "`null` removes"])
      expect(md).toContain(word);
    expect(md).toContain("catherd catalog treat-like <rung> <scored rung>");
    expect(md).not.toContain("the TUI edits");
  });

  it("keeps spec §11's conversation rules and offers the isolation toggle", () => {
    const md = skill("catherd-setup");
    expect(md).toContain("One question at a time");
    expect(md).toContain("recommended answer");
    expect(md).toContain("never re-argue");
    expect(md).toContain("You never edit a file by hand");
    expect(md).toContain("native keeps your hooks, skills and AGENTS.md");
    expect(md).toContain("Recommend native");
    expect(md).toContain("Codex reports no per-request input, so it has no harness figure");
    expect(md).toContain("Codex has none: it reports no per-request input");
    for (const bad of ["Vigen", "agora"]) expect(md).not.toContain(bad);
  });
});
