import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { overridePath } from "../../src/services/catalog-service.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
function catherd(...args: string[]) {
  return catherdIn(undefined, "/nonexistent", ...args);
}
/** git alone on PATH, so the command can find the repository it runs in but no backend CLI. */
function gitOnlyPath(): string {
  const bin = mkdtempSync(join(tmpdir(), "catherd-bin-"));
  symlinkSync(Bun.which("git") as string, join(bin, "git"));
  return bin;
}
function catherdIn(cwd: string | undefined, path: string, ...args: string[]) {
  const p = Bun.spawnSync([process.execPath, CLI, "catalog", ...args], {
    cwd,
    // no backend CLI on PATH: refresh lists nothing, and never touches the user's own
    env: { ...process.env, PATH: path, ANTHROPIC_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("catherd catalog", () => {
  it("lists models with their scored rungs, as text or JSON", () => {
    withHome();
    const text = catherd("list", "--backend", "codex", "--text", "gpt-6-sol");
    expect(text.code).toBe(0);
    expect(text.out).toContain("codex:gpt-6-sol  5/6 rungs scored  roles ");
    const json = JSON.parse(catherd("list", "--role", "artist", "--json").out);
    expect(json.models.every((m: { backend: string }) => m.backend === "codex")).toBe(true);
  });

  it("refuses an unknown role with exit 2 and the fix", () => {
    withHome();
    const r = catherd("list", "--role", "chef");
    expect([r.code, r.err]).toEqual([
      2,
      `error E_INPUT_INVALID: no role "chef"\nfix: pass --role ${"architect|verifier|worker|reviewer|ui-reviewer|artist|writer|researcher"}\n`,
    ]);
  });

  it("saves a treat-like, and refuses one onto an unscored rung", () => {
    withHome();
    const ok = catherd("treat-like", "opencode:opencode-go/kimi-k3#default", "codex:gpt-6-sol#medium");
    expect([ok.code, ok.out]).toEqual([
      0,
      "✓ opencode-go/kimi-k3#default is treated like gpt-6-sol#medium\n",
    ]);
    expect(JSON.parse(readFileSync(overridePath(), "utf8")).treatLike).toEqual({
      "opencode-go/kimi-k3#default": "gpt-6-sol#medium",
    });
    const bad = catherd("treat-like", "a/b#high", "a/c#high");
    expect(bad.code).toBe(1);
    expect(bad.err).toStartWith("error E_CONFIG_INVALID: a/c#high has no scores of its own to lend\nfix: ");
  });

  it("refuses a malformed rung with exit 1 and leaves the override file unchanged", () => {
    withHome();
    expect(catherd("treat-like", "a/b#high", "gpt-6-sol#high").code).toBe(0);
    const before = readFileSync(overridePath(), "utf8");
    const bad = catherd("treat-like", "foo", "gpt-6-sol#high");
    expect([bad.code, bad.out]).toEqual([1, ""]);
    expect(bad.err).toStartWith('error E_INPUT_INVALID: "foo" is not a rung\nfix: ');
    expect(readFileSync(overridePath(), "utf8")).toBe(before);
    expect(catherd("list", "--backend", "codex").code).toBe(0);
  });

  it("refuses a treat-like for a rung that is already scored, with exit 1", () => {
    withHome();
    const r = catherd("treat-like", "codex:gpt-6-sol#high", "gpt-6-sol#xhigh");
    expect([r.code, r.out]).toEqual([1, ""]);
    expect(r.err).toStartWith("error E_CONFIG_INVALID: gpt-6-sol#high has scores of its own");
  });

  it("lists and refreshes opencode for the repository it runs in, and globally outside one", () => {
    withHome();
    const repo = realpathSync(tempRepo());
    const kimi = [{ id: "opencode-go/kimi-k3", efforts: [], context: 262144, imageIn: false }];
    const at = Date.parse("2026-09-25T10:00:00.000Z");
    writeDiscovery("opencode", kimi, at, repo);
    const path = gitOnlyPath();
    const inRepo = JSON.parse(catherdIn(repo, path, "list", "--text", "kimi", "--json").out);
    expect(inRepo.total).toBe(1);
    const outside = mkdtempSync(join(tmpdir(), "catherd-norepo-"));
    expect(JSON.parse(catherdIn(outside, path, "list", "--text", "kimi", "--json").out).total).toBe(0);
    // opencode cannot list here, so refresh reports the repository's own last listing
    const rows = JSON.parse(catherdIn(repo, path, "refresh", "--json").out) as {
      backend: string;
      fetchedAt: string | null;
    }[];
    expect(rows.find((x) => x.backend === "opencode")?.fetchedAt).toBe(new Date(at).toISOString());
    const global = JSON.parse(catherdIn(outside, path, "refresh", "--json").out) as typeof rows;
    expect(global.find((x) => x.backend === "opencode")?.fetchedAt).toBeNull();
  });

  it("refreshes every backend, keeping the claude-code list without an API key", () => {
    withHome();
    const r = catherd("refresh", "--json");
    const rows = JSON.parse(r.out) as { backend: string; models: number; error?: string }[];
    expect(rows.find((x) => x.backend === "claude-code")?.models).toBe(4);
    expect(rows.find((x) => x.backend === "codex")?.error).toBe(
      "listed no models; the previous listing is kept",
    );
    expect(r.code).toBe(0);
  });
});
