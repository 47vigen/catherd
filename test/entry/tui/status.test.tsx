import { afterEach, describe, expect, it } from "bun:test";
import { CatherdError } from "../../../src/domain/errors.ts";
import { FIXTURE_REPORT, fixtureEffects } from "../../../src/entry/tui/fixtures.ts";
import { RUNS_EVERY_MS } from "../../../src/entry/tui/providers/data.tsx";
import { StatusView } from "../../../src/entry/tui/views/status.tsx";
import { snapshotEnv, withHome } from "../../helpers.ts";
import { type Harness, harness } from "./harness.tsx";
import { Shell } from "./shell.tsx";

afterEach(snapshotEnv());
let h: Harness | null = null;
afterEach(async () => {
  await h?.s.close();
  h = null;
});

async function status(effects = fixtureEffects()) {
  withHome();
  h = await harness(
    <Shell width={80} height={19}>
      <StatusView width={80} height={19} />
    </Shell>,
    { effects, width: 80, height: 19 },
  );
  await h.advance(0);
  return effects;
}

describe("the Status tab (spec §9.1)", () => {
  it("shows each check as glyph, word and detail, with its whole fix command wrapped under it", async () => {
    await status();
    const f = h!.s.frame();
    expect(f).toContain("✓ ready         codex — 0.156.1, logged in, 14 models");
    expect(f).toContain("! not logged in opencode");
    expect(f).toContain("fix: opencode auth login");
    expect(f).toContain("fix: claude plugin marketplace add 47vigen/catherd &&");
    expect(f).toContain("claude plugin install catherd@catherd");
    expect(f).toContain("checked just now");
  });

  it("copies the selected check's fix with y, and says when a row has none", async () => {
    await status();
    await h!.s.press("y");
    expect(h!.s.frame()).toContain("This row has no fix command");
    await h!.s.press("j", "j", "j", "j", "j", "y");
    expect(h!.copied).toEqual(["opencode auth login"]);
  });

  it("re-checks with r, and says when it last checked", async () => {
    const effects = fixtureEffects();
    let calls = 0;
    const doctor = effects.doctor;
    effects.doctor = () => {
      calls++;
      return doctor();
    };
    await status(effects);
    await h!.advance(65_000);
    expect(h!.s.frame()).toContain("checked 1m ago");
    await h!.s.press("r");
    expect(calls).toBe(2);
    expect(h!.s.frame()).toContain("checked just now");
  });

  it("opens the active profile or a recent run with enter", async () => {
    await status();
    await h!.s.press("shift+g", "k", "k", "return");
    expect(h!.app().getState()).toMatchObject({ tab: "profiles", profile: "default" });
    await h!.s.press("shift+g", "return");
    expect(h!.app().getState()).toMatchObject({ tab: "runs", run: "20260925-090000-auth-refactor" });
  });

  it("shows and opens the profile this repo runs on", async () => {
    const fx = fixtureEffects({ repo: "/r", bindings: { "/r": "cheap" } });
    fx.create("cheap");
    await status(fx);
    expect(h!.s.frame()).toContain("cheap  this repo · 2 profiles");
    await h!.s.press("shift+g", "k", "k", "return");
    expect(h!.app().getState()).toMatchObject({ tab: "profiles", profile: "cheap" });
  });

  it("opens doctor's profile row as the global active profile, and a profile:<name> row as <name>", async () => {
    const bound = {
      id: "profile:cheap",
      label: "profile cheap",
      state: "ok" as const,
      word: "ready",
      detail: "valid",
    };
    const fx = fixtureEffects({
      repo: "/r",
      bindings: { "/r": "cheap" },
      report: { ...FIXTURE_REPORT, checks: [bound, ...FIXTURE_REPORT.checks] },
    });
    fx.create("cheap");
    await status(fx);
    await h!.s.press("return");
    expect(h!.app().getState()).toMatchObject({ tab: "profiles", profile: "cheap" });
    await h!.run(() => h!.app().dispatch({ type: "tab", tab: "status" }));
    await h!.s.press("g", "j", "j", "j", "return");
    expect(h!.app().getState()).toMatchObject({ tab: "profiles", profile: "default" });
  });

  it("says why with its fix when enter opens a profile that cannot be read", async () => {
    const fx = fixtureEffects();
    fx.readProfile = () => {
      throw new CatherdError("E_CONFIG_INVALID", "default.json is not valid JSON", {
        fix: "catherd profile reset default",
      });
    };
    await status(fx);
    await h!.s.press("shift+g", "k", "k", "return");
    expect(h!.s.frame()).toContain("default.json is not valid JSON");
    expect(h!.s.frame()).toContain("catherd profile reset default");
    expect(h!.app().getState().tab).toBe("status");
  });

  it("picks up a profile made active in another terminal on the next poll", async () => {
    const fx = fixtureEffects();
    fx.create("cheap");
    await status(fx);
    expect(h!.s.frame()).toContain("default  active · 2 profiles");
    fx.create("fast");
    fx.activate("cheap");
    await h!.advance(RUNS_EVERY_MS);
    expect(h!.s.frame()).toContain("cheap  active · 3 profiles");
  });

  it("wraps a long detail, such as a path, in full instead of cutting it (spec §9.3: paths wrap)", async () => {
    const path =
      "/home/someone/.local/share/catherd/locks/heavy-builds-for-a-rather-long-repository-name.lock";
    const lock = {
      id: "lock",
      label: "heavy lock",
      state: "warn" as const,
      word: "held",
      detail: `${path} held by pid 4242`,
    };
    await status(fixtureEffects({ report: { ...FIXTURE_REPORT, checks: [lock, ...FIXTURE_REPORT.checks] } }));
    const f = h!.s.frame();
    expect(f.replace(/\s+/g, "")).toContain(`heavylock—${path}heldbypid4242`);
    expect(f).not.toContain("…");
    for (const line of f.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
  });
});
