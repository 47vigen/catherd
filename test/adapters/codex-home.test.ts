import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedImages, isolatedCodexHome } from "../../src/adapters/codex/home.ts";
import { codexAdapter } from "../../src/adapters/codex/index.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

function userCodex(): string {
  const dir = mkdtempSync(join(tmpdir(), "catherd-codex-user-"));
  writeFileSync(join(dir, "auth.json"), "{}");
  process.env.CODEX_HOME = dir;
  return dir;
}

describe("isolatedCodexHome", () => {
  it("replaces a broken auth.json link instead of failing with EEXIST", () => {
    const home = withHome();
    const user = userCodex();
    const iso = join(home, "data", "codex-home");
    mkdirSync(iso, { recursive: true });
    symlinkSync(join(home, "gone", "auth.json"), join(iso, "auth.json"));
    expect(isolatedCodexHome()).toBe(iso);
    expect(readlinkSync(join(iso, "auth.json"))).toBe(join(user, "auth.json"));
  });

  it("replaces a link that points at another auth.json", () => {
    const home = withHome();
    const other = userCodex();
    const user = userCodex();
    const iso = join(home, "data", "codex-home");
    mkdirSync(iso, { recursive: true });
    symlinkSync(join(other, "auth.json"), join(iso, "auth.json"));
    isolatedCodexHome();
    expect(readlinkSync(join(iso, "auth.json"))).toBe(join(user, "auth.json"));
  });
});

describe("generatedImages", () => {
  it("skips a file that vanished between listing and stat", () => {
    const home = mkdtempSync(join(tmpdir(), "catherd-codex-img-"));
    const dir = join(home, "generated_images", "t1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.png"), "x");
    // A dangling link lists like a file but fails stat with ENOENT, as a deleted file would.
    symlinkSync(join(dir, "missing.png"), join(dir, "b.png"));
    expect(generatedImages(home, "t1", 0)).toEqual([join(dir, "a.png")]);
  });
});

describe("codex finalize", () => {
  it("looks for images of an isolated run without creating catherd's Codex home", () => {
    const home = withHome();
    userCodex();
    const o = codexAdapter.finalize({
      request: {
        rung: parseRung("codex:gpt-6-sol#high"),
        access: "workspace-write",
        thread: "thread-1",
        isolated: true,
        repo: "/repo",
        briefPath: "/d/brief.md",
        replyPath: "/d/reply.md",
        dispatchDir: "/d",
      },
      eventLines: [],
      reply: "done",
      stderr: "",
      exit: { code: 0, signal: null, reason: "exited", endedAt: "2026-09-25T00:00:00.000Z" },
      startedAtMs: 0,
    });
    expect(o.images).toEqual([]);
    expect(existsSync(join(home, "data", "codex-home"))).toBe(false);
  });
});
