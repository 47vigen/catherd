import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { overridePath } from "../../src/services/catalog-service.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
function catherd(...args: string[]) {
  const p = Bun.spawnSync([process.execPath, CLI, "catalog", ...args], {
    // no backend CLI on PATH: refresh lists nothing, and never touches the user's own
    env: { ...process.env, PATH: "/nonexistent", ANTHROPIC_API_KEY: "" },
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
