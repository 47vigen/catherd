import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capText, FINDING_MAX, issueTitle } from "../../src/services/brief-cap.ts";
import { snapshotEnv } from "../helpers.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

describe("capping a brief's long texts (plan 44 D7)", () => {
  it("a long finding is cut and kept whole in notes/", () => {
    const { run } = freshRun();
    const text = `BUG src/a.ts:3 — ${"x".repeat(5_000)}`;
    const cut = capText(run, text, FINDING_MAX);
    expect(cut.length).toBeLessThanOrEqual(2_200);
    const file = /notes\/[0-9a-f]{12}\.md/.exec(cut)?.[0];
    expect(file).toBeDefined();
    expect(readFileSync(join(run.dir, file as string), "utf8")).toBe(text);
    expect(capText(run, text, FINDING_MAX)).toBe(cut);
  });

  it("a text within the cap is returned as it is, and writes nothing", () => {
    const { run } = freshRun();
    expect(capText(run, "BUG a — b", FINDING_MAX)).toBe("BUG a — b");
    expect(existsSync(join(run.dir, "notes"))).toBe(false);
  });

  it("an issue is its first line, at most 160 characters", () => {
    expect(issueTitle("A8 red-first: accepted\nsecond line\nthird")).toBe("A8 red-first: accepted");
    const long = issueTitle("y".repeat(900));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long).toEndWith("…");
  });
});
