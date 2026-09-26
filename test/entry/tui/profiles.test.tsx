import { afterEach, describe, expect, it } from "bun:test";
import { fixtureEffects } from "../../../src/entry/tui/fixtures.ts";
import { useApp } from "../../../src/entry/tui/providers/app.tsx";
import { useData } from "../../../src/entry/tui/providers/data.tsx";
import { useCommandLayer } from "../../../src/entry/tui/providers/keymap.tsx";
import {
  openNewProfile,
  openProfileList,
  useProfileDialogs,
} from "../../../src/entry/tui/views/profile-actions.ts";
import { ProfilesView } from "../../../src/entry/tui/views/profiles.tsx";
import { snapshotEnv, withHome } from "../../helpers.ts";
import { type Harness, harness } from "./harness.tsx";
import { Shell } from "./shell.tsx";

/** What the App adds for this tab: the profile dialogs' handlers and the leader's profile commands. */
function ProfileCommands() {
  const app = useApp();
  const data = useData();
  useProfileDialogs();
  useCommandLayer("app", {
    "profile.new": () => openNewProfile(app),
    "profile.list": () => openProfileList(app, data),
  });
  return null;
}

afterEach(snapshotEnv());
let h: Harness | null = null;
afterEach(async () => {
  await h?.s.close();
  h = null;
});

async function profiles(
  setup: (fx: ReturnType<typeof fixtureEffects>) => void = () => {},
  effects: ReturnType<typeof fixtureEffects> = fixtureEffects(),
) {
  withHome();
  setup(effects);
  h = await harness(
    <Shell width={100} height={35}>
      <ProfileCommands />
      <ProfilesView width={100} height={35} />
    </Shell>,
    { effects, width: 100, height: 35 },
  );
  await h.advance(0);
  await h.advance(0);
  return effects;
}

/** Moves the cursor with the filter to the first row matching `text`, then leaves the filter. */
async function find(text: string) {
  await h!.s.press("/");
  await h!.s.type(text);
  await h!.s.press("return");
}

describe("the Profiles tab", () => {
  it("opens and closes rows with → and ←, and ← on a leaf goes to its parent", async () => {
    await profiles();
    const open = "workspace-write · enforced";
    expect(h!.s.frame()).toContain(open);
    await h!.s.press("j", "j", "left");
    expect(h!.s.frame()).not.toContain(open);
    await h!.s.press("right");
    expect(h!.s.frame()).toContain(open);
    await h!.s.press("j", "left", "left");
    expect(h!.s.frame()).not.toContain(open);
  });

  it("cycles access with enter, and shows how strongly the backend holds it", async () => {
    const fx = await profiles();
    await find("worker access");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("full · enforced");
    await h!.s.press("ctrl+s", "return");
    expect(fx.writes).toEqual(['save default {"roles":{"worker":{"access":"full"}}}']);
  });

  it("maps an unscored rung with the treat-like picker, stages it, and saves both", async () => {
    const fx = await profiles();
    await find("worker gpt-6-sol ultra");
    await h!.s.press("space");
    expect(h!.s.frame()).toContain("Treat codex:gpt-6-sol#ultra like…");
    await h!.s.type("gpt-6-sol#xhigh");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("treated like gpt-6-sol#xhigh · unsaved");
    expect(h!.s.frame()).toContain("2 unsaved");
    await h!.s.press("ctrl+s");
    expect(h!.s.frame()).toContain("treat codex:gpt-6-sol#ultra like gpt-6-sol#xhigh");
    await h!.s.press("return");
    expect(fx.writes).toHaveLength(1);
    expect(fx.writes[0]).toContain('{"codex:gpt-6-sol#ultra":"gpt-6-sol#xhigh"}');
  });

  it("picks a failover stand-in on another quota, marked inferred when it is", async () => {
    const fx = await profiles();
    await find("failover luna");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("Stand-in for codex:gpt-6-luna#high");
    await h!.s.type("none");
    await h!.s.press("return");
    await h!.s.press("ctrl+s", "return");
    expect(fx.writes).toEqual(['save default {"failover":{"codex:gpt-6-luna#high":null}}']);
  });

  it("offers a rung made usable by a staged treat-like as a failover stand-in", async () => {
    await profiles();
    // an unscored rung on another quota than luna's (a stand-in never shares the quota it stands in for)
    await find("worker claude-code sonnet low");
    await h!.s.press("space");
    expect(h!.s.frame()).toContain("Treat claude-code:claude-sonnet-5#low like…");
    await h!.s.type("gpt-6-sol#xhigh");
    await h!.s.press("return", "escape");
    await find("failover luna");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("Stand-in for codex:gpt-6-luna#high");
    await h!.s.type("sonnet-5#low");
    expect(h!.s.frame()).toContain("claude-sonnet-5#low");
    expect(h!.s.frame()).not.toContain("No match");
  });

  it("refuses a bad number and keeps it in the editor; empty clears a budget cap", async () => {
    const fx = await profiles();
    await find("budget usd");
    await h!.s.press("return");
    await h!.s.type("1.2.3");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain('"1.2.3" is not a number above 0');
    for (let i = 0; i < 5; i++) await h!.s.press("backspace");
    await h!.s.type("5");
    await h!.s.press("return", "ctrl+s", "return");
    expect(fx.writes).toEqual(['save default {"budget":{"usd":5}}']);
  });

  it("shows an issue on its row and blocks the save with it", async () => {
    await profiles();
    await find("worker");
    await h!.s.press("space");
    expect(h!.s.frame()).toContain("the worker cannot be disabled");
    await h!.s.press("ctrl+s");
    expect(h!.s.frame()).toContain("[ Cancel ]");
    expect(h!.s.frame()).not.toContain("[ Save ]");
  });

  it("makes a profile active only through its confirmation", async () => {
    const fx = await profiles((f) => f.create("cheap"));
    await h!.s.press("ctrl+x", "l");
    await h!.s.type("cheap");
    await h!.s.press("return", "a");
    expect(h!.s.frame()).toContain("Make cheap active?");
    await h!.s.press("return");
    expect(fx.writes).toEqual(["create cheap", "activate cheap"]);
    expect(h!.s.frame().split("\n")[0]).toContain("PROFILE cheap (active)");
  });

  it("inside a bound repo, opens on its profile and binds the repo", async () => {
    const fx = await profiles(
      (f) => {
        f.create("cheap");
        f.create("other");
      },
      fixtureEffects({ repo: "/home/me/app", bindings: { "/home/me/app": "cheap" } }),
    );
    expect(h!.s.frame().split("\n")[0]).toContain("PROFILE cheap (this repo)");
    await h!.s.press("ctrl+x", "l");
    await h!.s.type("other");
    await h!.s.press("return", "a");
    expect(h!.s.frame()).toContain("Use other in this repo?");
    await h!.s.press("return");
    expect(fx.writes.at(-1)).toBe("bind other /home/me/app");
    expect(h!.s.frame().split("\n")[0]).toContain("PROFILE other (this repo)");
  });

  it("creates a profile from the name prompt, refusing a bad name first", async () => {
    const fx = await profiles();
    await h!.s.press("ctrl+x", "n");
    await h!.s.type("Fast");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("use lowercase letters");
    for (let i = 0; i < 4; i++) await h!.s.press("backspace");
    await h!.s.type("fast");
    await h!.s.press("return");
    expect(fx.writes).toEqual(["create fast"]);
    expect(h!.s.frame()).toContain("PROFILE fast");
  });

  it("keeps the prompt open with the errors when the new profile would not validate", async () => {
    const fx = await profiles((f) => {
      f.create = (name) => {
        f.writes.push(`refused ${name}`);
        return {
          saved: false,
          errors: [{ path: "roles.worker.rungs", message: "no rung can run here" }],
          warnings: [],
          diff: [],
          linked: [],
          pruned: [],
          newSessionNeededFor: [],
        };
      };
    });
    await h!.s.press("ctrl+x", "n");
    await h!.s.type("fast");
    await h!.s.press("return");
    expect(fx.writes).toEqual(["refused fast"]);
    expect(h!.s.frame()).toContain("roles.worker.rungs: no rung can run here");
    expect(h!.s.frame()).not.toContain("Created profile");
  });

  it("applies two keys that land in one tick to the draft as it is, not as it was drawn", async () => {
    await profiles();
    await find("verifier");
    await h!.run(() => {
      h!.keymap().dispatchCommand("tree.toggle");
      h!.keymap().dispatchCommand("tree.toggle");
    });
    expect(h!.s.frame()).not.toContain("unsaved");
    expect(h!.app().getState().drafts.default?.past).toHaveLength(2);
  });

  it("will not delete the active profile, and says why", async () => {
    const fx = await profiles();
    await h!.s.press("ctrl+x", "l", "ctrl+d", "ctrl+d");
    expect(h!.s.frame()).toContain("is the active profile");
    expect(fx.writes).toEqual([]);
  });
});
