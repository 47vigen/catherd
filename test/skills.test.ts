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
      "gate_check",
      "gate_pass",
      "park",
      "answer",
    ]) {
      expect(used).toContain(core);
    }
  });

  it("tells a Codex coordinator to run in tmux once, and to end a goal continuation with no tool call (plan 22)", () => {
    const md = skill("catherd");
    const codex = md.slice(md.indexOf("### On Codex"), md.indexOf("\n## ", md.indexOf("### On Codex")));
    expect(codex).toContain("When `$TMUX` and `$STY` are both empty, tell the user once");
    expect(codex).toContain("A goal continuation while only roles are live ends the turn with no tool call");
    expect(codex).toContain("`actionable: false`");
  });

  it("names test_push in the tool table and the Codex half, with the shell's --thread form (plan 22)", () => {
    const md = skill("catherd");
    expect(md).toContain("| `test_push()`");
    expect(md).toContain("`catherd doctor --test-push --thread <uuid>`");
    const codex = md.slice(md.indexOf("### On Codex"), md.indexOf("\n## ", md.indexOf("### On Codex")));
    expect(codex).toContain("with `test_push`");
  });

  it("dispatches roles one after another, then ends its turn; results arrive as catherd messages (spec 1.1 §3.8)", () => {
    const md = skill("catherd");
    const after = md.slice(
      md.indexOf("## After dispatching"),
      md.indexOf("\n## ", md.indexOf("## After dispatching") + 1),
    );
    expect(after).toContain("one after another");
    expect(after).toContain("Then write one status line and end your turn.");
    expect(after).toContain('`<cross-session-message from-name="catherd">`');
    expect(after).toContain("`result(run, name)`");
    expect(after).toContain("Never `sleep`");
    expect(after).toContain("once after `run_start` on a resumed run");
    expect(after).toMatch(/neither[^\n]*user approval/);
    // plan 10's push facts the orchestrator still needs
    expect(after).toContain("catherd messages the session that dispatched");
    // spec 1.5 plan 21: only the orchestrator calls the coordinator tools
    expect(after).toContain("Only you, the orchestrator, call the coordinator tools");
    expect(after).toContain("refuses them with `E_ROLE_SCOPE`");
    expect(after).toContain("every coalesced event");
    expect(md).toContain("so catherd messages you from now on");
    expect(md).toContain("call `peek(run)` once and answer from it");
    for (const old of [
      "`wait(",
      "`wait`",
      "same message",
      "One message per transition",
      "Launch every independent role in the same message",
      "in one message, each at its rung",
      "All lanes go at once",
      "Each dispatch backgrounds by itself",
      "its dispatch call returns the same record",
      "Launch it now, in the same message",
      "`dispatch` has already",
      "## Waiting",
    ])
      expect(md).not.toContain(old);
  });

  it("keeps the gate ledger with native Claude foreground and process dispatch/result verification", () => {
    const md = skill("catherd");
    expect(md).toContain("A native Claude verifier runs in the foreground on Claude Code");
    expect(md).toContain("`gate_check` first and skips an item that passed on the same content");
    expect(md).toContain('`record_agent_run(run, "verifier-<M>", "verifier", rung, …)`');
    // a FAIL recorded ok would open the land gate
    expect(md).toContain('with `status: "failed"` when its verdict is FAIL: only a PASS is recorded `ok`');
    expect(md).toContain(
      "a `reviewer-<M>` dispatch record, or a native Claude `record_agent_run` row with role reviewer",
    );
    expect(md).toContain("A process verifier on either host uses `dispatch`/`result`");
  });

  it("leaves the reply contract, the routing and the land gate to the tools (spec 1.1 §6)", () => {
    const md = skill("catherd");
    expect(md).toContain("`dispatch` appends the role's reply contract to every brief");
    // spec 1.5 plan 21
    expect(md).toContain("with `lane`, `dispatch` inlines the lane file as it stands");
    expect(md).toContain(
      "Its brief names the files it may change on an `Owns:` line (default: `docs/**` and `*.md`)",
    );
    expect(md).not.toContain('"Do not commit." Then the reply shape');
    expect(md).toContain("`dispatch` routes a lane you missed");
    for (const code of ["E_LANE_INVALID", "E_LAND_GATE", "E_CLIMB_DESIGN"]) expect(md).toContain(code);
    expect(md).toContain('`skip: "docs-only"`');
  });

  it("parks an owner question instead of stopping, and re-enters with peek and Protocol next (spec 1.1 §8, §10)", () => {
    const md = skill("catherd");
    expect(md).toContain("`park(run, milestone, question)` parks that milestone");
    expect(md).toContain("`answer(run, milestone, answer)`");
    expect(md).toContain("`Protocol next:`");
    expect(md).toContain(
      "Before dispatching anything, call `peek(run)` once: it lists the open owner questions first",
    );
    expect(md).toContain("`status(run)` shows it");
  });

  it("keeps plan 10's peek, result, single-role and duplicate-name details (spec 1.1 §3.7)", () => {
    const md = skill("catherd");
    const row = (tool: string) => md.split("\n").find((l) => l.startsWith(`| \`${tool}(`)) ?? "";
    expect(row("peek")).toContain("each live role with its rung, time and last event");
    expect(row("peek")).toContain("the next step");
    expect(row("peek")).toContain("It marks nothing read");
    expect(row("result")).toContain("its `hints`");
    expect(row("result")).toContain("reading a finished record marks it read");
    expect(md).toContain("A single role is `dispatch`, then end your turn.");
    expect(md).toContain(
      "`E_ADMIT_DUPLICATE`: that role name is already running. It reports through a catherd message when it finishes; `peek(run, name)` shows it now, and `cancel` stops it.",
    );
    // never tell the orchestrator to wait on a role: it ends its turn and catherd's message wakes it
    expect(md).not.toMatch(/\bwait for (it|them|the role)\b/i);
  });

  it("tells peek's caller the open questions are the owner's to answer, and the run goes on (spec 1.1 §8)", async () => {
    const tools = (await (await mcpClient()).listTools()).tools;
    const d = tools.find((t) => t.name === "peek")?.description ?? "";
    expect(d).not.toContain("answer them before anything else");
    expect(d).toContain("the owner's questions: push them to the owner");
    expect(d).toContain("relay the owner's answer with answer(run, milestone, answer)");
    expect(d).toContain("go on with the work that does not depend on them");
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
      "its targeted tests plus the linter of every package the lane touches, and the type check when the repo has one, scoped to those packages",
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
