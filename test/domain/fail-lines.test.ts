import { describe, expect, it } from "bun:test";
import * as failLines from "../../src/domain/fail-lines.ts";
import { andTail, checkFailLines, checkVerdict, newFails } from "../../src/domain/fail-lines.ts";

describe("check failing lines", () => {
  it("andTail names what follows the first &&", () => {
    expect(andTail("a && b && c")).toBe("b && c");
    expect(andTail("bun test")).toBeNull();
    expect(() => andTail("a &&")).toThrow("empty check item");
  });
  it("strips colour, timings and counters, so two runs compare equal", () => {
    const a = checkFailLines("\x1b[31mFAIL\x1b[0m src/a.test.ts > adds [12.3ms]\nok 1 fine\n");
    expect(a).toEqual(checkFailLines("FAIL src/a.test.ts > adds (40 ms)\n"));
    expect(a).toEqual(["FAIL src/a.test.ts > adds"]);
  });
  it("keeps a vulnerability by its id, and the usual failure markers", () => {
    expect(
      checkFailLines(
        "Vulnerability #1: GO-2026-0042\n--- FAIL: TestX\nnot ok 3 y\npanic: boom\nerror: z\n(fail) w\n",
      ),
    ).toEqual([
      "vulnerability GO-2026-0042",
      "--- FAIL: TestX",
      "not ok 3 y",
      "panic: boom",
      "error: z",
      "(fail) w",
    ]);
  });
  it("no cap", () => {
    const out = Array.from({ length: 90 }, (_, i) => `FAIL t${i} ${"x".repeat(400)}`).join("\n");
    expect(checkFailLines(out)).toHaveLength(90);
    expect(checkFailLines(out)[0]).toHaveLength(300);
  });
  it("a passing line that names FAIL is no failure", () => {
    expect(
      checkFailLines(
        [
          "(pass) parseFailLines > lists the FAIL and BUG lines [0.12ms]",
          "payment-panel test:    ✓ TestNoRefundSectionOnAnUncapturedLeg: FAILED",
          "ok 3 - FAIL marker",
          "--- PASS: TestFAIL (0.00s)",
          "(pass) see (fail) elsewhere",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(checkFailLines("(fail) a > b\n--- FAIL: TestX\nFAIL x: ok done")).toEqual([
      "(fail) a > b",
      "--- FAIL: TestX",
      "FAIL x: ok done",
    ]);
  });
  it("a fail line carries its block's files", () => {
    const out = [
      "test/services/capture.test.ts:",
      "error: expect(received).toMatchObject(expected)",
      "      at <anonymous> (/work/tree/test/services/capture.test.ts:127:5)",
      "      at settle (/work/tree/src/adapters/opencode/index.ts:290:9)",
      "      at x (/work/tree/node_modules/a/b.js:1:1)",
      "      at y (/elsewhere/c.ts:2:2)",
      "(fail) capture-fixtures > records the totals [12.00ms]",
      "(pass) capture-fixtures > other",
    ].join("\n");
    const files = ["test/services/capture.test.ts", "src/adapters/opencode/index.ts"];
    expect(failLines.failFiles(out, "/work/tree")).toEqual({
      "error: expect(received).toMatchObject(expected)": files,
      "(fail) capture-fixtures > records the totals": files,
    });
  });
  it("a header carries to the later blocks of its file, a new one replaces it", () => {
    const out = ["a/one.test.ts:", "(pass) x", "(fail) y", "b/two.spec.ts:", "(fail) z src/q.ts:3"].join(
      "\n",
    );
    expect(failLines.failFiles(out, "/r")).toEqual({
      "(fail) y": ["a/one.test.ts"],
      "(fail) z src/q.ts:3": ["b/two.spec.ts", "src/q.ts"],
    });
  });
  it("names the lines the base does not have", () => {
    expect(newFails(["FAIL a", "FAIL b"], ["FAIL a"])).toEqual(["FAIL b"]);
    expect(newFails(["FAIL a"], null)).toEqual(["FAIL a"]);
  });
});

describe("check items", () => {
  it("keeps nested quoted substitutions whole", () => {
    const command = 'echo "$(printf "x && y")"';
    expect(failLines.checkItems(command)).toEqual([command]);
    expect(failLines.checkItems(`${command} && bun test`)).toEqual([command, "bun test"]);
    const nested = 'echo "$(printf "%s" "$(printf "x && y")")"';
    expect(failLines.checkItems(`${nested} && echo done`)).toEqual([nested, "echo done"]);
    expect(failLines.checkItems('echo "$(printf ") && (")" && echo done')).toEqual([
      'echo "$(printf ") && (")"',
      "echo done",
    ]);
  });
  it("checkItems keeps an if/fi block whole", () => {
    for (const block of [
      "if c; then a && b; fi",
      "if a && b; then c; elif d && e; then f; else g && h; fi",
      "if [[ -f a && -f b ]]; then { a && b; }; fi",
    ])
      expect(failLines.checkItems(`${block} && z`)).toEqual([block, "z"]);
    expect(failLines.checkItems("if c; then a && b; fi && d")).toEqual(["if c; then a && b; fi", "d"]);
  });
  it("checkItems keeps a [[ ]] test whole", () => {
    expect(failLines.checkItems("[[ -f a && -f b ]] && c")).toEqual(["[[ -f a && -f b ]]", "c"]);
  });
  it("checkItems keeps a { } group whole", () => {
    expect(failLines.checkItems("{ a && b; } && c")).toEqual(["{ a && b; }", "c"]);
  });
  it("checkItems keeps loops and case whole", () => {
    for (const block of [
      "while a && b; do c && d; done",
      "until a; do b && c; done",
      "for f in x y; do a && b; done",
      "select f in x y; do a && b; done",
      "case $x in a) b && c;; esac",
      "case $x in esac",
      "case $x in (a|b) if c; then d && f; fi;; *) g && h;; esac",
      "while [[ -f a && -f b ]]; do case $x in a) b && c;; esac; done",
    ])
      expect(failLines.checkItems(`${block} && e`)).toEqual([block, "e"]);
  });
  it("recognizes control constructs after shell command separators", () => {
    for (const separator of [";", "||", "|", "&", "\n"]) {
      const block = `prep ${separator} if c; then a && b; fi`;
      expect(failLines.checkItems(`${block} && d`)).toEqual([block, "d"]);
    }
    expect(failLines.checkItems("! { a && b; } && c")).toEqual(["! { a && b; }", "c"]);
  });
  it("checkItems treats reserved words as words outside command position", () => {
    expect(failLines.checkItems("grep -q fi f && echo done && b")).toEqual([
      "grep -q fi f",
      "echo done",
      "b",
    ]);
    expect(failLines.checkItems("echo {a,b} && c")).toEqual(["echo {a,b}", "c"]);
    expect(failLines.checkItems('test "${x}" && c')).toEqual(['test "${x}"', "c"]);
  });
  it("checkItems keeps a command it cannot parse whole", () => {
    for (const command of [
      "if a && b",
      "a && fi && b",
      "a && b << EOF",
      "a && b # c && d",
      "a && done",
      "a && { b; fi; }",
      "a && 'b",
      "a && (b",
      "a && b)",
      "a && [[ b && c",
      "a && b \\",
    ])
      expect(failLines.checkItems(command)).toEqual([command]);
    expect(() => failLines.checkItems("a && && b")).toThrow(
      expect.objectContaining({ code: "E_INPUT_INVALID" }),
    );
    expect(failLines.checkItems("a && b <<< c")).toEqual(["a", "b <<< c"]);
  });
  it("keeps unsupported time prefixes whole", () => {
    for (const command of [
      "time [[ -f a && -f b ]] && c",
      "a && time -p [[ -f a && -f b ]] && c",
      "time { a && b; } && c",
    ])
      expect(failLines.checkItems(command)).toEqual([command]);
    expect(failLines.checkItems("echo time && c")).toEqual(["echo time", "c"]);
  });
  it("keeps unquoted parameter expansions whole", () => {
    for (const command of [
      "echo ${x:-a && b} && c",
      "a && echo ${x:-${y:-b && c}} && d",
      'echo "$(echo ${x:-a && b})" && c',
      "echo ${x:-a && b && c",
    ])
      expect(failLines.checkItems(command)).toEqual([command]);
    expect(failLines.checkItems("echo '${x:-a && b}' && c")).toEqual(["echo '${x:-a && b}'", "c"]);
    expect(failLines.checkItems(String.raw`echo \${x} && c`)).toEqual([String.raw`echo \${x}`, "c"]);
  });
  it("rejects detected empty items before every conservative fallback", () => {
    for (const suffix of [
      "b # comment",
      "fi",
      "b << EOF",
      "'b",
      "(b",
      "b)",
      "if b",
      "b \\",
      "time [[ -f a && -f b ]]",
      "echo ${x:-a && b}",
    ])
      expect(() => failLines.checkItems(`a && && ${suffix}`)).toThrow(
        expect.objectContaining({ code: "E_INPUT_INVALID" }),
      );
  });
  it("rejects empty check items before returning any commands", () => {
    for (const command of ["", "  ", "true &&", "true &&  ", "&& true", "true && && false"]) {
      expect(() => failLines.checkItems(command)).toThrow("empty check item");
    }
    expect(failLines.checkItems('echo "" && true')).toEqual(['echo ""', "true"]);
  });
  it("checkItems splits top-level && and keeps quoted &&", () => {
    expect(failLines.checkItems('a && b "x && y"')).toEqual(["a", 'b "x && y"']);
    expect(failLines.checkItems("bun test")).toEqual(["bun test"]);
    expect(failLines.checkItems("a 'x && y' && b")).toEqual(["a 'x && y'", "b"]);
  });
  it("checkItems keeps a subshell whole", () => {
    expect(failLines.checkItems('a && (cd web && b) && "x && y"')).toEqual([
      "a",
      "(cd web && b)",
      '"x && y"',
    ]);
    expect(failLines.checkItems("(cd web && bun run gen) && (cd web && bun test)")).toEqual([
      "(cd web && bun run gen)",
      "(cd web && bun test)",
    ]);
  });
  it("keeps nested parentheses and escaped quotes balanced", () => {
    const nested = String.raw`a "x \" && y" && (b && (c && d)) && e`;
    expect(failLines.checkItems(nested)).toEqual([String.raw`a "x \" && y"`, "(b && (c && d))", "e"]);
    expect(failLines.checkItems(String.raw`a \&\& b && c`)).toEqual([String.raw`a \&\& b`, "c"]);
    expect(andTail('a "x && y" && (b && c) && d')).toBe("(b && c) && d");
    expect(andTail('a "x && y"')).toBeNull();
  });
  it("a leading cd runs with the rest", () => {
    expect(failLines.checkItems("bun install && cd services/credit && task acceptance")).toEqual([
      "bun install",
      "cd services/credit && task acceptance",
    ]);
    expect(failLines.checkItems('cd "my dir" && b && c')).toEqual(['cd "my dir" && b && c']);
    expect(failLines.checkItems("a && cd d && cd e && c")).toEqual(["a", "cd d && cd e && c"]);
    expect(failLines.checkItems("(cd web && bun test) && lint")).toEqual(["(cd web && bun test)", "lint"]);
    expect(() => failLines.checkItems("cd d && && b")).toThrow("empty check item");
  });
  it("coveredDir names the subshell's folder", () => {
    expect(failLines.coveredDir("(cd web && bun run test)")).toBe("web/");
    expect(failLines.coveredDir("cd a/b && x")).toBe("a/b/");
    expect(failLines.coveredDir("cd web/ && x")).toBe("web/");
    expect(failLines.coveredDir("bun test")).toBeNull();
  });
  it("coveredDir is null for an item it cannot pin to one folder", () => {
    for (const item of [
      "(cd web && a) || b",
      "(cd web && a) ; (b)",
      "cd web && cd .. && b",
      "cd . && b",
      "cd ../x && b",
      "cd /x && b",
      "cd - && b",
      "cd web",
    ])
      expect(failLines.coveredDir(item)).toBeNull();
  });
});

describe("failure normalization", () => {
  it("the same failure in two runs normalises equal", () => {
    const a =
      "FAIL verifier-M1 20261023-105527-run-audit-fixes-plan-39 /tmp/first/project/check.ts port 41234";
    const b = "FAIL verifier-M3 20261024-225501-another-run /var/tmp/second/project/check.ts port 52011";
    expect(failLines.normalizeFailLine(a)).toBe(failLines.normalizeFailLine(b));
    expect(checkFailLines(a)).toEqual(checkFailLines(b));
    expect(failLines.normalizeFailLine(a)).toBe("FAIL <role> <run> <tmp> port <port>");
  });
  it("normalizes absolute paths and address ports without hiding distinct failures", () => {
    expect(failLines.normalizeFailLine("error: worker-M1.L1 /workspace/one/a.ts 127.0.0.1:41234")).toBe(
      "error: <role> <path> 127.0.0.1:<port>",
    );
    expect(checkFailLines("FAIL one /workspace/a\nFAIL two /workspace/b")).toEqual([
      "FAIL one <path>",
      "FAIL two <path>",
    ]);
    expect(failLines.FAIL_DISPLAY_CAP).toBe(60);
  });
});

describe("plan 52: a failing check against the same command on the base", () => {
  const base = (exit: number | null, failures: string[]) => ({ exit, failures });
  it("is inherited when the base fails every line it fails, new when one line is not on the base", () => {
    expect(checkVerdict(0, [], null)).toBe("pass");
    expect(checkVerdict(1, ["(fail) a"], base(1, ["(fail) a", "(fail) b"]))).toBe("inherited");
    expect(checkVerdict(1, ["(fail) a", "(fail) c"], base(1, ["(fail) a"]))).toBe("new");
    expect(checkVerdict(1, ["(fail) a"], base(0, []))).toBe("new");
  });
  it("is unknown with no base, on a timeout, or with no line to compare and the base failing too", () => {
    expect(checkVerdict(1, ["(fail) a"], null)).toBe("unknown");
    expect(checkVerdict(null, ["(fail) a"], base(1, ["(fail) a"]))).toBe("unknown");
    expect(checkVerdict(2, [], base(2, []))).toBe("unknown");
    expect(checkVerdict(2, [], base(0, []))).toBe("new");
  });
});
