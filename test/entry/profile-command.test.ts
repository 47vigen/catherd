import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultProfileDoc } from "../../src/domain/profile.ts";
import { claudeAgentsDir } from "../../src/infra/paths.ts";
import { activeName, getProfile, profilesDir } from "../../src/services/profile-store.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";

afterEach(snapshotEnv());

function catherd(args: string[], cwd?: string) {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "profile", ...args], {
    env: { ...process.env, CATHERD_ORCHESTRATION_HOST: "claude-code", NO_COLOR: "1", ANTHROPIC_API_KEY: "" },
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("catherd profile show", () => {
  it("shows each role's access and enforcement, and says whose scores a stand-in borrows", () => {
    withHome();
    const r = catherd(["show"]);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toBe("profile default (active)");
    expect(lines.find((l) => l.startsWith("  reviewer"))).toBe(
      "  reviewer     read-only, enforced          codex:gpt-6-sol#high",
    );
    expect(lines.find((l) => l.startsWith("  architect"))).toContain("read-only, advisory");
    // Go's Luna has scores of its own and borrows only agentic and steer; Kimi K3 has none, so it borrows Sol's
    expect(r.out).toContain(
      "  codex:gpt-6-luna#high → opencode:opencode-go/gpt-6-luna#high (agentic, steer borrowed from gpt-5.6-luna#high)\n",
    );
    expect(r.out).toContain(
      "  codex:gpt-6-sol#medium → opencode:opencode-go/kimi-k3#max (scores borrowed from gpt-6-sol#medium)\n",
    );
    expect(r.out).not.toContain("treated like");
    expect(r.out).toContain(
      "harness codex native · claude-code native · opencode native · cursor native · grok native · antigravity native\n",
    );
  });

  it("marks a role whose network is off (spec §5)", () => {
    withHome();
    expect(catherd(["set", "roles.writer.network", "false"]).code).toBe(0);
    const writer = catherd(["show"])
      .out.split("\n")
      .find((l) => l.startsWith("  writer"));
    expect(writer).toContain("workspace-write (no network), enforced");
  });

  it("prints JSON with every default filled in", () => {
    withHome();
    const j = JSON.parse(catherd(["show", "--json"]).out);
    expect(j.profile.timeouts).toEqual({ idleMin: 15, wallMin: 90 });
    expect(j.enforcement.worker).toBe("enforced");
    expect(j.standIns[1]).toEqual({
      from: "codex:gpt-6-sol#medium",
      to: "opencode:opencode-go/kimi-k3#max",
      inferred: true,
      via: "gpt-6-sol#medium",
      note: "scores borrowed from gpt-6-sol#medium",
    });
  });
});

describe("catherd profile set", () => {
  it("saves one field, prints the change and any warning, and relinks the agents", () => {
    withHome();
    const r = catherd(["set", "roles.verifier.access", "read-only"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "✓ roles.verifier.access: full → read-only",
        "! roles.verifier.access: verifier runs read-only; catherd's default for it is full",
        "new Claude Code session needed for: catherd-default-architect-claude-opus-5-5-high, catherd-default-verifier-claude-opus-5-5-low",
        "",
      ].join("\n"),
    );
    expect(getProfile("default", "claude-code").roles.verifier.access).toBe("read-only");
    expect(existsSync(join(claudeAgentsDir(), "catherd-default-verifier-claude-opus-5-5-low.md"))).toBe(true);
  });

  it("refuses an invalid result with exit 1 and saves nothing", () => {
    withHome();
    const r = catherd(["set", "roles.worker.enabled", "false"]);
    expect([r.code, r.err]).toEqual([
      1,
      "error E_CONFIG_INVALID: the profile was not saved: roles.worker.enabled: the worker cannot be disabled\nfix: catherd profile set roles.worker.enabled true\n",
    ]);
    expect(existsSync(join(profilesDir(), "default.json"))).toBe(false);
  });

  it("saves a repair of an invalid profile, and lists the errors still open (spec 1.2 §6.2)", () => {
    withHome();
    mkdirSync(profilesDir(), { recursive: true });
    const doc = defaultProfileDoc();
    const broken = {
      ...doc,
      roles: { ...doc.roles, worker: { ...doc.roles?.worker, enabled: false } },
      failover: { "codex:gpt-6-sol#high": "codex:gpt-6-luna#high" },
    };
    writeFileSync(join(profilesDir(), "default.json"), JSON.stringify(broken));
    const r = catherd(["set", "roles.worker.enabled", "true"]);
    expect(r.code).toBe(0);
    expect(r.out).toStartWith(
      [
        "✓ roles.worker.enabled: false → true",
        "! saved; 1 error is still open:",
        "✗ failover.codex:gpt-6-sol#high: stand-in codex:gpt-6-luna#high draws on the same quota as codex:gpt-6-sol#high, which is out when codex:gpt-6-sol#high hits its limit",
      ].join("\n"),
    );
    expect(getProfile("default", "claude-code").roles.worker.enabled).toBe(true);
  });

  it("refuses an unknown path with exit 2", () => {
    withHome();
    const r = catherd(["set", "roles.worker.colour", "red"]);
    expect(r.code).toBe(2);
    expect(r.err).toStartWith(
      'error E_INPUT_INVALID: cannot set roles.worker.colour to red: ✖ Unrecognized key: "colour"',
    );
  });

  it("sets a failover whose rung holds dots, and removes it with null", () => {
    withHome();
    expect(
      catherd(["set", "failover.codex:gpt-5.6-sol#high", "opencode:opencode-go/gpt-5.6-luna#max"]).code,
    ).toBe(0);
    expect(getProfile("default", "claude-code").failover["codex:gpt-5.6-sol#high"]).toBe(
      "opencode:opencode-go/gpt-5.6-luna#max",
    );
    expect(catherd(["set", "failover.codex:gpt-5.6-sol#high", "null"]).code).toBe(0);
    expect(getProfile("default", "claude-code").failover["codex:gpt-5.6-sol#high"]).toBeUndefined();
  });
});

describe("catherd profile use, new, copy, rm, list, diff", () => {
  it("binds a profile to the repo it runs in, and refuses --repo outside one", () => {
    withHome();
    const repo = tempRepo();
    expect(catherd(["new", "fast"]).code).toBe(0);
    const r = catherd(["use", "fast", "--repo"], repo);
    expect(r.out.split("\n")[0]).toMatch(/^✓ fast is bound to \/.+$/);
    expect(r.out).toContain(
      "new Claude Code session needed for: catherd-fast-architect-claude-opus-5-5-high",
    );
    const top = r.out.split("\n")[0]?.replace("✓ fast is bound to ", "") as string;
    expect(activeName(top)).toBe("fast");
    const outside = catherd(["use", "fast", "--repo"], "/");
    expect([outside.code, outside.err.split("\n")[0]]).toEqual([
      2,
      "error E_INPUT_INVALID: / is not inside a git repository",
    ]);
  });

  it("creates, copies, lists, diffs and deletes profiles", () => {
    withHome();
    catherd(["set", "budget.minutes", "5"]);
    expect(catherd(["copy", "default", "team"]).out).toBe("✓ copied default to team\n");
    expect(catherd(["new", "fast"]).code).toBe(0);
    expect(catherd(["use", "team"]).out).toBe(
      "✓ team is active\nnew Claude Code session needed for: catherd-default-architect-claude-opus-5-5-high, catherd-default-verifier-claude-opus-5-5-low, catherd-team-architect-claude-opus-5-5-high, catherd-team-verifier-claude-opus-5-5-low\n",
    );
    expect(catherd(["list"]).out).toBe("  default\n  fast\n* team\n");
    expect(catherd(["diff", "fast"]).out).toBe("budget.minutes: 5 → none\n");
    expect(catherd(["diff", "team", "default"]).out).toBe("no differences\n");
    const busy = catherd(["rm", "team"]);
    expect([busy.code, busy.err.split("\n")[0]]).toEqual([
      2,
      'error E_INPUT_INVALID: "team" is the active profile',
    ]);
    expect(catherd(["rm", "fast"]).out).toBe("✓ deleted fast\n");
    expect(JSON.parse(catherd(["list", "--json"]).out)).toEqual([
      { name: "default", active: false, repos: [] },
      { name: "team", active: true, repos: [] },
    ]);
  });

  it("refuses to copy an invalid profile with exit 1 and writes nothing", () => {
    withHome();
    mkdirSync(profilesDir(), { recursive: true });
    const doc = readFileSync(join(SRC, "..", "test", "fixtures", "profiles", "bad.json"), "utf8");
    writeFileSync(join(profilesDir(), "bad.json"), doc);
    const r = catherd(["copy", "bad", "x"]);
    expect([r.code, r.out]).toEqual([1, ""]);
    const [line, fix, rest] = r.err.split("\n");
    expect(line).toStartWith("error E_CONFIG_INVALID: the profile was not saved: roles.reviewer.rungs: ");
    expect(line).toContain('gpt-6-sol has no effort "turbo" on codex');
    expect(fix).toStartWith("fix: ");
    expect(rest).toBe("");
    expect(existsSync(join(profilesDir(), "x.json"))).toBe(false);
  });

  it("show and list, run inside a bound repo, use the repo's profile; outside it, the active one", () => {
    withHome();
    const repo = tempRepo();
    catherd(["new", "fast"]);
    catherd(["use", "fast", "--repo"], repo);
    expect(catherd(["show"], repo).out.split("\n")[0]).toBe("profile fast (active)");
    expect(catherd(["show", "default"], repo).out.split("\n")[0]).toBe("profile default");
    expect(catherd(["list"], repo).out).toStartWith("  default\n* fast  bound to ");
    expect(catherd(["show"], "/").out.split("\n")[0]).toBe("profile default (active)");
    expect(catherd(["list"], "/").out).toStartWith("* default\n  fast  bound to ");
  });

  it("set, validate and diff without a name, inside a bound repo, act on the repo's profile", () => {
    withHome();
    const repo = tempRepo();
    catherd(["new", "fast"]);
    catherd(["use", "fast", "--repo"], repo);
    expect(catherd(["set", "budget.minutes", "7"], repo).out).toStartWith("✓ budget.minutes: none → 7\n");
    expect(getProfile("fast", "claude-code").budget.minutes).toBe(7);
    expect(getProfile("default", "claude-code").budget.minutes).toBeUndefined();
    expect(catherd(["diff", "default"], repo).out).toBe("budget.minutes: 7 → none\n");
    expect(catherd(["validate"], repo).out).toBe("✓ valid\n");
  });
});

describe("names the user types, and unbinding", () => {
  it("refuses a missing profile name with exit 2 in show, diff, validate and set --profile", () => {
    withHome();
    for (const args of [
      ["show", "nope"],
      ["diff", "nope"],
      ["validate", "nope"],
    ]) {
      const r = catherd(args);
      expect([r.code, r.err]).toEqual([
        2,
        'error E_INPUT_INVALID: no profile named "nope"\nfix: catherd profile list\n',
      ]);
    }
    const set = catherd(["set", "budget.usd", "5", "--profile", "nope"]);
    expect([set.code, set.err]).toEqual([
      2,
      'error E_INPUT_INVALID: no profile named "nope"\nfix: catherd profile new nope\n',
    ]);
    expect(existsSync(join(profilesDir(), "nope.json"))).toBe(false);
  });

  it("use --repo --clear unbinds the repo, which then runs on the active profile", () => {
    withHome();
    const repo = tempRepo();
    catherd(["new", "fast"]);
    catherd(["use", "fast", "--repo"], repo);
    const r = catherd(["use", "--repo", "--clear"], repo);
    expect([r.code, r.out.split("\n")[0]]).toEqual([0, expect.stringMatching(/^✓ \/.+ is unbound$/)]);
    expect(catherd(["show"], repo).out.split("\n")[0]).toBe("profile default (active)");
    expect(catherd(["rm", "fast"]).out).toBe("✓ deleted fast\n");
    const again = catherd(["use", "--repo", "--clear"], repo);
    expect([again.code, again.err.split("\n")[0]]).toEqual([
      2,
      expect.stringMatching(/^error E_INPUT_INVALID: \/.+ is bound to no profile$/),
    ]);
    const bare = catherd(["use"]);
    expect(bare.code).toBe(2);
  });
});

describe("catherd profile validate", () => {
  it("prints errors and warnings, and exits 1 on an error", () => {
    withHome();
    expect(catherd(["validate"])).toEqual({ code: 0, out: "✓ valid\n", err: "" });
    mkdirSync(profilesDir(), { recursive: true });
    const doc = JSON.parse(readFileSync(join(SRC, "..", "test", "fixtures", "profiles", "bad.json"), "utf8"));
    writeFileSync(join(profilesDir(), "bad.json"), JSON.stringify(doc));
    const r = catherd(["validate", "bad"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ roles.reviewer.rungs: gpt-6-sol has no effort "turbo" on codex');
    // spec 1.2 §6.1: unscored is a warning, never an error
    expect(r.out).toContain(
      "! roles.reviewer.rungs: codex:gpt-6-sol#turbo is unscored and no rung is near enough to stand in for it: routing skips it\n",
    );
    expect(r.out).toContain(
      "! roles.verifier.access: verifier runs read-only; catherd's default for it is full\n",
    );
  });
});

it("reviews a narrow Codex reset and refuses a stale reviewed file without changing stored bytes", () => {
  withHome();
  mkdirSync(profilesDir(), { recursive: true });
  const path = join(profilesDir(), "default.json");
  const doc = {
    ...defaultProfileDoc(),
    future: { keep: true },
    roles: {
      ...defaultProfileDoc().roles,
      architect: {
        rungs: ["claude:claude-opus-5-5#high"],
        defaultRung: "claude:claude-opus-5-5#high",
        future: "keep",
      },
      verifier: { rungs: ["claude:claude-opus-5-5#low"] },
    },
  };
  writeFileSync(path, JSON.stringify(doc));
  const before = readFileSync(path, "utf8");
  const run = (args: string[], host = "codex") => {
    const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), "profile", ...args, "--host", host], {
      env: { ...process.env, CATHERD_ORCHESTRATION_HOST: host, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const preview = run(["reset-host-defaults", "--preview", "--json"]);
  expect(preview.code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(before);
  const reviewed = join(profilesDir(), "reviewed.json");
  writeFileSync(reviewed, preview.out);
  writeFileSync(path, JSON.stringify({ ...doc, budget: { usd: 3 } }));
  const changed = readFileSync(path, "utf8");
  expect(run(["reset-host-defaults", "--expect", reviewed]).code).toBe(1);
  expect(readFileSync(path, "utf8")).toBe(changed);
  writeFileSync(reviewed, run(["reset-host-defaults", "--preview", "--json"]).out);
  // a codex preview never approves the claude-code reset
  expect(run(["reset-host-defaults", "--expect", reviewed], "claude-code").code).toBe(1);
  expect(readFileSync(path, "utf8")).toBe(changed);
  expect(run(["reset-host-defaults", "--expect", reviewed]).code).toBe(0);
  const stored = JSON.parse(readFileSync(path, "utf8"));
  expect(stored.roles.architect).toEqual({ future: "keep" });
  expect(stored.future).toEqual({ keep: true });
  expect(stored.budget).toEqual({ usd: 3 });
  expect(existsSync(claudeAgentsDir())).toBe(false);
});
