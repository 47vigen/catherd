import { describe, expect, it } from "bun:test";
import { OPENCODE_AGENT_FILES } from "../../src/adapters/opencode/agents.ts";

type Effect = "allow" | "deny" | "ask";
interface Rule {
  action: string;
  resource: string;
  effect: Effect;
}

/** opencode v2 `Wildcard.match` (packages/core/src/util/wildcard.ts:3-13), line for line. */
function match(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp("^" + escaped + "$", "s").test(normalized);
}

/** opencode v2 `evaluate` (packages/core/src/permission.ts:87-96): the last matching rule, else ask. */
const evaluate = (action: string, resource: string, rules: Rule[]): Effect =>
  rules.findLast((r) => match(action, r.action) && match(resource, r.resource))?.effect ?? "ask";

/**
 * opencode v2 `evaluateInput` (packages/core/src/permission.ts:165-178), without saved approvals (a
 * configured deny beats them anyway): one denied resource denies the call, else any ask asks.
 */
function decide(action: string, resources: string[], rules: Rule[]): Effect {
  const effects = resources.map((r) => evaluate(action, r, rules));
  return effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow";
}

/** The rules opencode reads from the agent file's frontmatter, parsed as YAML. */
function rulesOf(file: string): Rule[] {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(file)?.[1];
  const doc = Bun.YAML.parse(front ?? "") as { permissions: Rule[] };
  return doc.permissions;
}

/**
 * Each command with the resources opencode's shell tool asks about. `split` is what its legacy
 * tree-sitter scan yields (packages/core/src/shell/parse.ts:173-205: one resource per `command` node,
 * nested substitutions included, with the redirect text when the parent is a redirected_statement),
 * reproduced with web-tree-sitter 0.25.10 and tree-sitter-bash. The whole command text is checked as
 * well, so the rules hold even if opencode ever matched it unsplit.
 */
const ESCAPES: [string, string[]][] = [
  ["rg --pre=sh x", ["rg --pre=sh x"]],
  ["git diff --output=/tmp/x", ["git diff --output=/tmp/x"]],
  ["git log -p --output /tmp/x", ["git log -p --output /tmp/x"]],
  ["git show HEAD -o /tmp/x", ["git show HEAD -o /tmp/x"]],
  ["ls; rm -rf x", ["ls", "rm -rf x"]],
  ["git status && git commit -m x", ["git status", "git commit -m x"]],
  ["ls || rm x", ["ls", "rm x"]],
  ["ls & rm x", ["ls", "rm x"]],
  ["ls src\nrm -rf x", ["ls src", "rm -rf x"]],
  ["cat a > b", ["cat a > b"]],
  ["git diff >b", ["git diff >b"]],
  ["cat a | tee b", ["cat a", "tee b"]],
  ["cat <(id)", ["cat <(id)", "id"]],
  ["echo $(id)", ["echo $(id)", "id"]],
  ["ls $(id)", ["ls $(id)", "id"]],
  ["ls `id`", ["ls `id`", "id"]],
  ["git statusx", ["git statusx"]],
];

const READS: [string, string[]][] = [
  "git diff HEAD~1",
  "git log -5",
  "ls src",
  "ls",
  "git status",
  "git show HEAD:src/a.ts",
  "cat README.md",
  "pwd",
].map((c) => [c, [c]]);

describe("catherd-ro under opencode v2's permission semantics", () => {
  const rules = rulesOf(OPENCODE_AGENT_FILES["catherd-ro"] as string);

  // a redirect after a list or pipeline reaches no resource (`ls && cat a > b` asks for "ls" and "cat a"),
  // so no allowlist is read-only: every shell command is denied, plain reads included
  for (const [command, split] of [...ESCAPES, ...READS, ["ls && cat a > b", ["ls", "cat a"]] as const])
    it(`denies ${JSON.stringify(command)}`, () => {
      expect(decide("shell", [...split], rules)).toBe("deny");
      expect(decide("shell", [command], rules)).toBe("deny");
    });

  it("allows the read tools and denies edits (edit, write and patch all ask for `edit`)", () => {
    for (const action of ["read", "glob", "grep"]) expect(decide(action, ["src/a.ts"], rules)).toBe("allow");
    expect(decide("edit", ["src/a.ts"], rules)).toBe("deny");
    expect(rules.some((r) => r.action === "edit" && r.effect === "deny")).toBe(true);
    expect(rules.some((r) => r.action === "shell" && r.effect === "allow")).toBe(false);
    expect(decide("subagent", ["general"], rules)).toBe("deny");
  });
});
