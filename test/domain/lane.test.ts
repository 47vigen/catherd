import { describe, expect, it } from "bun:test";
import { isCatherdError } from "../../src/domain/errors.ts";
import { normalizeOwned, overlaps, parseLaneHeader } from "../../src/domain/lane.ts";

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
    });
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
