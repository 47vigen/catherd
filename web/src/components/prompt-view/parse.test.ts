import architect from "./fixtures/architect-brief.md?raw";
import worker from "./fixtures/worker-brief.md?raw";
import { parsePrompt, type PromptTag, wordCount } from "./parse";
import { splitPlaceholders, tokenize } from "./tokens";

const tags = (nodes: ReturnType<typeof parsePrompt>) => nodes.filter((n): n is PromptTag => n.kind === "tag");

test("a real worker brief parses into its six sections, with the plan tasks and lane file nested in the task", () => {
  const top = tags(parsePrompt(worker));
  expect(top.map((t) => t.name)).toEqual(["role", "team", "context", "task", "done_when", "reply_contract"]);
  const task = top[3]!;
  const nested = tags(task.children);
  expect(nested.map((t) => [t.name, t.attrs])).toEqual([
    ["plan-task", { file: "2026-10-22-03-case.md", id: "1" }],
    ["plan-task", { file: "2026-10-22-03-case.md", id: "2" }],
    ["lane-file", { path: "lanes/M1.L1.md" }],
  ]);
  expect(nested[0]!.children[0]).toMatchObject({
    kind: "text",
    text: expect.stringMatching(/^### Task 1: capitalize/),
  });
  // Inline placeholders stay inside the prose.
  const role = top[0]!.children[0];
  expect(role).toMatchObject({ kind: "text", text: expect.stringContaining("reply DESIGN: <task> — <the conflict>") });
  expect(wordCount(top)).toBeGreaterThan(1000);
});

test("a real architect brief keeps its indented code and placeholders as text", () => {
  const top = tags(parsePrompt(architect));
  expect(top.map((t) => t.name)).toEqual(["role", "team", "task", "done_when", "reply_contract"]);
  expect(top.every((t) => !t.unclosed)).toBe(true);
  expect(JSON.stringify(top[0])).toContain("# Mx.Ly — <one line>");
});

test("a prompt with no tags is one text node", () => {
  expect(parsePrompt("Just do it.\n\nRun <command> once.")).toEqual([
    { kind: "text", text: "Just do it.\n\nRun <command> once." },
  ]);
  expect(parsePrompt("")).toEqual([]);
});

test("a lone placeholder line, a stray closer and an unknown unclosed tag stay text", () => {
  const nodes = parsePrompt("<run>\n</task>\n<foo>\nbody");
  expect(nodes).toEqual([{ kind: "text", text: "<run>\n</task>\n<foo>\nbody" }]);
});

test("a known section left open (a cut-off prompt) runs to the end, marked unclosed", () => {
  const nodes = parsePrompt('<role>\nA.\n</role>\n<task>\nDo B with <path>.\n<plan-task id="1">\nhalf');
  const [role, task] = tags(nodes);
  expect(role).toMatchObject({ name: "role", children: [{ kind: "text", text: "A." }] });
  expect(task).toMatchObject({ name: "task", unclosed: true });
  expect(tags(task!.children)[0]).toMatchObject({ name: "plan-task", attrs: { id: "1" }, unclosed: true });
});

test("mismatched nesting closes what matches and leaves the rest as text", () => {
  const nodes = parsePrompt("<a>\n<b>\nx\n</a>\n</b>");
  expect(nodes).toEqual([
    { kind: "tag", name: "a", attrs: {}, children: [{ kind: "text", text: "<b>\nx" }] },
    { kind: "text", text: "</b>" },
  ]);
});

test("same-name nesting, one-line tags, single-quoted attributes and fenced tags", () => {
  const nodes = parsePrompt(
    "<note kind='x'>\n<note>\ninner\n</note>\n</note>\n<hint>short</hint>\n```xml\n<role>\n</role>\n```",
  );
  expect(nodes[0]).toMatchObject({
    name: "note",
    attrs: { kind: "x" },
    children: [{ name: "note", children: [{ text: "inner" }] }],
  });
  expect(nodes[1]).toMatchObject({ name: "hint", children: [{ text: "short" }] });
  expect(nodes[2]).toMatchObject({ kind: "text", text: "```xml\n<role>\n</role>\n```" });
});

test("prose splits into placeholders, tool names, commands and reply keywords", () => {
  const kinds = (s: string) =>
    tokenize(s)
      .filter((t) => t.kind !== "text")
      .map((t) => [t.kind, t.value]);
  expect(
    kinds(
      "When neither is listed, run catherd run-file read <run> <path>. Use mcp__plugin_catherd_catherd__read_run_file or read_run_file.",
    ),
  ).toEqual([
    ["command", "catherd run-file read <run> <path>"],
    ["tool", "mcp__plugin_catherd_catherd__read_run_file"],
    ["tool", "read_run_file"],
  ]);
  expect(kinds("wrap it in: bunx catherd-cli@2.0.0-next.20261022184738 lock -- <command>. Other lanes")).toEqual([
    ["command", "bunx catherd-cli@2.0.0-next.20261022184738 lock -- <command>"],
  ]);
  expect(kinds("reply DESIGN: <task> — <the conflict>, then STATUS: blocked; your $TMPDIR: here")).toEqual([
    ["keyword", "DESIGN:"],
    ["placeholder", "<task>"],
    ["placeholder", "<the conflict>"],
    ["keyword", "STATUS:"],
  ]);
  expect(kinds("(mcp__catherd_role__<name>)")).toEqual([["tool", "mcp__catherd_role__<name>"]]);
  expect(kinds("catherd runs the loop: it briefs every role")).toEqual([]);
  expect(tokenize("plain")).toEqual([{ kind: "text", value: "plain" }]);
});

test("code splits into literals and placeholders", () => {
  expect(splitPlaceholders("## M<n> — <title>")).toEqual([
    { hole: false, value: "## M" },
    { hole: true, value: "<n>" },
    { hole: false, value: " — " },
    { hole: true, value: "<title>" },
  ]);
});
