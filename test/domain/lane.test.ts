import { describe, expect, it } from "bun:test";
import { isCatherdError } from "../../src/domain/errors.ts";
import {
  assertLaneValues,
  normalizeOwned,
  onlyAllowedHits,
  overlaps,
  parseLaneHeader,
} from "../../src/domain/lane.ts";

const LANE = [
  "# M1.L2 — Add the export button",
  "Owns: src/export/, `src/app.ts`, ./README.md",
  "**Fast check:** `bun test test/export.test.ts`",
  "Kind: repo_code",
  "Difficulty: build",
  "",
  "Body text. Owns: not-this.ts",
].join("\n");

describe("parseLaneHeader", () => {
  it("reads the four header lines, tolerating markdown emphasis and backticks", () => {
    expect(parseLaneHeader(LANE)).toEqual({
      title: "M1.L2 — Add the export button",
      owns: ["src/export/", "src/app.ts", "README.md"],
      fastCheck: "bun test test/export.test.ts",
      kind: "repo_code",
      difficulty: "build",
      after: [],
      allow: [],
    });
  });

  it("reads After: lanes and the Allow: exceptions under the check", () => {
    const h = parseLaneHeader(`${LANE}\nAfter: M1.L1, \`M0.L3\`\nAllow: src/job/command.go:120, docs/`);
    expect(h.after).toEqual(["M1.L1", "M0.L3"]);
    expect(h.allow).toEqual(["src/job/command.go:120", "docs/"]);
  });
});

describe("assertLaneValues (write_run_file)", () => {
  it("refuses a wrong value, never a missing line", () => {
    expect(() => assertLaneValues("# M1.L1\nOwns: a.ts\n", "lanes/M1.L1.md")).not.toThrow();
    expect(() => assertLaneValues("# M1.L1\nDifficulty: medium\n", "lanes/M1.L1.md")).toThrow(
      'lanes/M1.L1.md: Difficulty "medium" is not one the catalog knows',
    );
    expect(() => assertLaneValues("# x\nAfter: L1\nAllow: /etc/passwd\n", "lanes/x.md")).toThrow(
      'After "L1" is not a lane id like M1.L1; Allow "/etc/passwd" is not a repo path, or path:line',
    );
    expect(() => assertLaneValues("# x\nOwns: ../out\n", "lanes/x.md")).toThrow("lanes/x.md: owned path");
  });
});

describe("onlyAllowedHits", () => {
  const allow = ["services/verification/internal/job/command.go:120", "docs/"];
  it("passes a check whose every hit is an allowed exception, and nothing else", () => {
    expect(onlyAllowedHits(["services/verification/internal/job/command.go:120:func Allowed()"], allow)).toBe(
      true,
    );
    expect(onlyAllowedHits(["docs/a.md:3:Allowed"], allow)).toBe(true);
    expect(onlyAllowedHits(["services/verification/internal/job/command.go:121:x"], allow)).toBe(false);
    expect(onlyAllowedHits(["error: rg not found"], allow)).toBe(false);
    expect(onlyAllowedHits([], allow)).toBe(false);
    expect(onlyAllowedHits(["docs/a.md:3:x"], [])).toBe(false);
  });

  it("returns nulls for missing or unknown kind and difficulty", () => {
    const h = parseLaneHeader("# x\nOwns: a.ts\nKind: poetry\n");
    expect(h.kind).toBeNull();
    expect(h.difficulty).toBeNull();
    expect(h.fastCheck).toBeNull();
  });
});

describe("normalizeOwned", () => {
  it("strips ./ and rejects absolute or escaping paths", () => {
    expect(normalizeOwned("./src/a.ts")).toBe("src/a.ts");
    for (const bad of ["/etc/passwd", "../x", "src/../../x", ""]) {
      try {
        normalizeOwned(bad);
        throw new Error("expected a throw");
      } catch (e) {
        expect(isCatherdError(e) && e.code).toBe("E_LANE_INVALID");
      }
    }
  });

  it("canonicalises . and empty segments and rejects paths that own nothing", () => {
    expect(normalizeOwned("src/./a.ts")).toBe("src/a.ts");
    expect(normalizeOwned("src//a.ts")).toBe("src/a.ts");
    expect(normalizeOwned("./src//x/")).toBe("src/x/");
    expect(overlaps([normalizeOwned("src/./a.ts")], ["src/a.ts"])).toEqual(["src/a.ts"]);
    expect(overlaps([normalizeOwned("src//a.ts")], ["src/a.ts"])).toEqual(["src/a.ts"]);
    for (const bad of [".", "./", "././", "src/./../x"]) {
      try {
        normalizeOwned(bad);
        throw new Error("expected a throw");
      } catch (e) {
        expect(isCatherdError(e) && e.code).toBe("E_LANE_INVALID");
      }
    }
  });
});

describe("overlaps", () => {
  it("treats a directory as covering everything under it, with or without a trailing slash", () => {
    expect(overlaps(["src/"], ["src/a.ts"])).toEqual(["src/"]);
    expect(overlaps(["src/a.ts"], ["src/"])).toEqual(["src/a.ts"]);
    expect(overlaps(["src"], ["src/a.ts"])).toEqual(["src"]);
    expect(overlaps(["src/a.ts"], ["src/a.ts"])).toEqual(["src/a.ts"]);
  });

  it("does not confuse a shared prefix with a parent directory", () => {
    expect(overlaps(["src/app"], ["src/apple.ts"])).toEqual([]);
    expect(overlaps(["a.ts", "b.ts"], ["c.ts"])).toEqual([]);
  });
});
