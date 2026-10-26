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
    for (const core of ["run_start", "status", "answer", "cancel", "result"]) expect(used).toContain(core);
  });

  it("tells the session to end its turn: the run does not need it", () => {
    const md = skill("catherd");
    expect(md).toContain("The run does not need this session");
    expect(md.split("\n").length).toBeLessThan(120);
  });

  it("starts with the A-lines and the notify url, answers parked units, and pushes only on the owner's word", () => {
    const md = skill("catherd");
    expect(md.replace(/\s+/g, " ")).toContain("Ask the owner every product question first");
    expect(md).toContain("`plan: <path>[, <path>…]`");
    expect(md).toContain("the notify url");
    expect(md).toContain("`answer(run, unit, answer)`");
    expect(md).toContain("`result(run)`");
    expect(md).toContain("Push and the merge request only on the owner's word");
  });

  it("starts a run on the owner's plan, approves the architect's, and keeps MR titles short", () => {
    const md = skill("catherd");
    for (const s of [
      "`plan:`",
      "answer approve",
      "`catherd run-file read <run> plan.md`",
      "DESIGN:",
      "under 72 characters",
    ])
      expect(md).toContain(s);
  });

  it("tells the session about base runs, the push answer and that catherd never merges (plan 35)", () => {
    const md = skill("catherd");
    expect(md).toContain("run_start(repo, title, a_lines, base)");
    expect(md).toContain("answer push");
    expect(md).toContain("catherd never opens an MR or merges");
    expect(md).toContain("limits.memory");
  });

  it("tells the orchestrator what to do with the report's rules review (plan 34)", () => {
    expect(skill("catherd")).toContain("rules review");
  });

  it("names no tool the daemon took over", () => {
    const md = skill("catherd");
    for (const gone of [
      "dispatch(",
      "peek(",
      "route(",
      "land(",
      "park(",
      "climb(",
      "gate_check",
      "record_agent_run",
    ])
      expect(md).not.toContain(gone);
  });

  it("pins this package's version", () => {
    const md = skill("catherd");
    const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    const pins = [...md.matchAll(/catherd-cli@([^\s`)"]+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins)).toEqual(new Set([version]));
  });

  it("carries no personal names or paths, and never isolates a role", () => {
    const md = skill("catherd");
    for (const bad of [
      "Vigen",
      "agora",
      "cx.sh",
      "jev.sh",
      "status.sh",
      "--ignore-user-config",
      "~/.claude/skills",
    ])
      expect(md).not.toContain(bad);
    expect(md.replace(/\s+/g, " ")).toContain("never isolate it");
  });
});

describe("setup skill", () => {
  beforeEach(() => withHome());

  it("is named catherd-setup and says when to trigger", () => {
    const fm = frontmatter(skill("catherd-setup"));
    expect(fm.name).toBe("catherd-setup");
    expect(fm.description).toContain("/catherd-setup");
  });

  it("reads the facts, writes only through the profile tool, and validates", async () => {
    const names = await toolNames();
    const md = skill("catherd-setup");
    for (const u of called(md)) expect(names).toContain(u);
    for (const action of ["get", "set", "validate"]) expect(md).toContain(`profile({ action: "${action}"`);
    expect(md).toContain("catherd catalog list --role <role> --json");
    for (const gone of ["profile_get", "profile_set", "profile_validate", "runs_summary", "catalog_query"])
      expect(md).not.toContain(gone);
  });

  it("covers every profile field profile_set stores, access with its enforcement, and the indexed-pairs rule", () => {
    const md = skill("catherd-setup");
    for (const field of [
      "`decision.url`",
      "`decision.model`",
      "`decision.minConfidence`",
      "`billing`",
      "`rungs`",
      "`defaultRung`",
      "`access`",
      "`roles.<role>.network: false`",
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
    expect(md).toContain("`catherd catalog list`");
    expect(md).toContain("indexed");
    expect(md).not.toContain("treat-like");
    expect(md).not.toContain("treat like");
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

  it("names the Slopalytics intelligence index, not the removed benchmark sources", () => {
    const md = skill("catherd-setup");
    expect(md).toContain("Slopalytics intelligence index");
    expect(md).not.toContain("Benchmark");
  });

  it("no shipped doc names Jev", () => {
    const root = join(import.meta.dir, "..");
    const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
    const docs = {
      "README.md": read("README.md"),
      "AGENTS.md": read("AGENTS.md"),
      "CLAUDE.md": read("CLAUDE.md"),
      "plugin skill": skill("catherd-setup"),
      "plugin.json": read("plugin", ".claude-plugin", "plugin.json"),
      "marketplace.json": read(".claude-plugin", "marketplace.json"),
    };
    for (const [name, text] of Object.entries(docs))
      expect([name, /\bjev\b/i.test(text)]).toEqual([name, false]);
    expect(docs["README.md"]).toContain("CATHERD_DECISION_KEY");
  });
});
