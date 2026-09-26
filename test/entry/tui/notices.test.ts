import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");

describe("third-party notices (spec §9.4)", () => {
  it("lists every file adapted from opencode, with opencode's MIT notice", () => {
    const notices = readFileSync(join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("Copyright (c) 2025 opencode");
    expect(notices).toContain("Permission is hereby granted, free of charge");
    const derived = [...new Bun.Glob("src/entry/tui/**/*.{ts,tsx}").scanSync({ cwd: ROOT })].filter((f) =>
      readFileSync(join(ROOT, f), "utf8").split("\n").slice(0, 3).join("\n").includes("anomalyco/opencode"),
    );
    expect(derived.length).toBeGreaterThan(0);
    for (const f of derived) expect(notices).toContain(`\`${relative(ROOT, join(ROOT, f))}\``);
  });

  it("ships the notices in the npm package", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("THIRD_PARTY_NOTICES.md");
  });
});
