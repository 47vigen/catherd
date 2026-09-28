import { afterEach, describe, expect, it } from "bun:test";
import { CatherdError } from "../../../src/domain/errors.ts";
import { applyPatch, defaultProfileDoc, resolveProfile } from "../../../src/domain/profile.ts";
import { fixtureEffects } from "../../../src/entry/tui/fixtures.ts";
import { useApp } from "../../../src/entry/tui/providers/app.tsx";
import { RUNS_EVERY_MS, useData } from "../../../src/entry/tui/providers/data.tsx";
import { useCommandLayer } from "../../../src/entry/tui/providers/keymap.tsx";
import {
  openNewProfile,
  openProfileList,
  openRevert,
  useProfileDialogs,
} from "../../../src/entry/tui/views/profile-actions.ts";
import { ProfilesView } from "../../../src/entry/tui/views/profiles.tsx";
import { writeDiscovery } from "../../../src/adapters/discovery.ts";
import { saveTreatLike } from "../../../src/services/catalog-service.ts";
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

/**
 * An unscored rung: a model OpenCode Go lists that catherd has no family, and no stand-in, for (every shipped
 * family's rung is scored, its own or carried from another effort, spec 1.2 §4.3).
 */
const GLM = "opencode:opencode-go/glm-5.3#high";

async function profiles(
  setup: (fx: ReturnType<typeof fixtureEffects>) => void = () => {},
  effects: ReturnType<typeof fixtureEffects> = fixtureEffects(),
) {
  withHome();
  writeDiscovery("opencode", [
    { id: "opencode-go/glm-5.3", efforts: ["high"], context: 200000, imageIn: false },
  ]);
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

  it("lines up a group's model column, long model names included (P5)", async () => {
    await profiles();
    const lines = h!.s.frame().split("\n");
    const start = lines.findIndex((l) => l.includes("claude (native subagent)"));
    const group = lines.slice(start + 1, start + 5);
    expect(group.some((l) => l.includes("claude-haiku-4-5-20251001"))).toBe(true);
    expect(new Set(group.map((l) => l.search(/\d+ of \d+/))).size).toBe(1);
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
    await find("worker glm-5.3 high");
    await h!.s.press("space");
    expect(h!.s.frame()).toContain(`Treat ${GLM} like…`);
    await h!.s.type("gpt-6-sol#xhigh");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("treated like gpt-6-sol#xhigh · unsaved");
    expect(h!.s.frame()).toContain("2 unsaved");
    await h!.s.press("ctrl+s");
    expect(h!.s.frame()).toContain(`treat ${GLM} like gpt-6-sol#xhigh`);
    await h!.s.press("return");
    expect(fx.writes).toHaveLength(1);
    expect(fx.writes[0]).toContain(`{"${GLM}":"gpt-6-sol#xhigh"}`);
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
    await find("worker glm-5.3 high");
    await h!.s.press("space");
    expect(h!.s.frame()).toContain(`Treat ${GLM} like…`);
    await h!.s.type("gpt-6-sol#xhigh");
    await h!.s.press("return", "escape");
    await find("failover luna");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("Stand-in for codex:gpt-6-luna#high");
    await h!.s.type("glm-5.3#high");
    expect(h!.s.frame()).toContain("glm-5.3#high");
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

  it("asks again, in the new words, when another process binds this repo while the prompt is open", async () => {
    const fx = await profiles(
      (f) => {
        f.create("cheap");
        f.create("other");
      },
      fixtureEffects({ repo: "/home/me/app" }),
    );
    await h!.s.press("ctrl+x", "l");
    await h!.s.type("cheap");
    await h!.s.press("return", "a");
    expect(h!.s.frame()).toContain("Make cheap active?");
    fx.activate("other", "/home/me/app");
    await h!.s.press("return");
    // nothing was applied on the old wording: the prompt is back, worded for the binding now
    expect(fx.writes).toEqual(["create cheap", "create other", "bind other /home/me/app"]);
    expect(h!.s.frame()).toContain("Use cheap in this repo?");
    // the notice wraps in the dialog: "…/home/me/app is now" / "bound to other."
    expect(h!.s.frame()).toMatch(
      /Changed since this was first asked: \/home\/me\/app is now\s+bound to other\./,
    );
    await h!.s.press("return");
    expect(fx.writes.at(-1)).toBe("bind cheap /home/me/app");
    expect(h!.s.frame()).toContain("cheap is bound to /home/me/app");
  });

  it("asks again when this repo's binding is removed while the prompt is open, then makes it active", async () => {
    const fx = await profiles(
      (f) => {
        f.create("cheap");
        f.create("other");
      },
      fixtureEffects({ repo: "/home/me/app", bindings: { "/home/me/app": "cheap" } }),
    );
    await h!.s.press("ctrl+x", "l");
    await h!.s.type("other");
    await h!.s.press("return", "a");
    expect(h!.s.frame()).toContain("Use other in this repo?");
    // another process removes the binding (the fixture has no unbind: its profiles read says so)
    const list = fx.profiles;
    fx.profiles = () => ({ ...list(), here: list().active, repo: null });
    await h!.s.press("return");
    expect(fx.writes).toEqual(["create cheap", "create other"]);
    expect(h!.s.frame()).toContain("Make other active?");
    expect(h!.s.frame()).toMatch(
      /Changed since this was first asked: \/home\/me\/app is no\s+longer bound\./,
    );
    await h!.s.press("return");
    // the scope the user confirmed, not one recomputed as the write happens
    expect(fx.writes.at(-1)).toBe("activate other");
    expect(h!.s.frame()).toContain("other is active");
  });

  it("goes back to the profile as saved now, when another process saved it meanwhile; undo brings the edit back", async () => {
    const fx = await profiles();
    await find("objective");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("1 unsaved");
    // another process saves a budget cap while the draft is open
    await fx.save("default", { budget: { usd: 5 } }, {});
    await h!.run(() => openRevert(h!.app()));
    expect(h!.s.frame()).toContain("Discard unsaved changes?");
    await h!.s.press("right", "return");
    let d = h!.app().getState().drafts.default!;
    expect([d.base.budget?.usd, d.doc.budget?.usd, d.doc.objective]).toEqual([5, 5, "cost"]);
    expect(h!.s.frame()).not.toContain("unsaved");
    expect(h!.s.frame()).toContain("default changed on disk: showing what is saved now");
    await h!.s.press("ctrl+x", "u");
    d = h!.app().getState().drafts.default!;
    expect([d.doc.budget?.usd, d.doc.objective]).toEqual([5, "speed"]);
    expect(h!.s.frame()).toContain("1 unsaved");
    await h!.s.press("ctrl+s", "return");
    expect(fx.writes).toEqual(['save default {"budget":{"usd":5}}', 'save default {"objective":"speed"}']);
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

  it("keeps the cursor on the edited row while a filter stays open", async () => {
    const fx = await profiles();
    await find("worker");
    await h!.s.press("j", "return", "return");
    expect(h!.s.frame()).toContain("read-only · enforced");
    await h!.s.press("ctrl+s", "return");
    expect(fx.writes).toEqual(['save default {"roles":{"worker":{"access":"read-only"}}}']);
  });

  it("unticks a ticked rung that has become unscored, without the treat-like picker", async () => {
    const glm = GLM;
    await profiles((f) => {
      const read = f.readProfile;
      f.readProfile = (n) => {
        const doc = read(n);
        const rungs = resolveProfile(doc, n).roles.worker.rungs;
        return applyPatch(doc, { roles: { worker: { rungs: [...rungs, glm] } } });
      };
    });
    await find("worker glm-5.3 high");
    await h!.s.press("space");
    expect(h!.s.frame()).not.toContain(`Treat ${GLM} like…`);
    expect(h!.s.frame()).toContain("1 unsaved");
    expect(h!.app().getState().drafts.default?.doc.roles?.worker?.rungs).not.toContain(glm);
  });

  it("shows a treat-like saved alone (the profile unchanged) as saved, from the catalog read again", async () => {
    const glm = GLM;
    const fx = await profiles((f) => {
      // the profile already ticks glm, saved while it was treated like a rung (the fixture's save is
      // synchronous up to its write), and reads back as a new object, as a file read does
      const rungs = resolveProfile(defaultProfileDoc(), "default").roles.worker.rungs;
      void f.save("default", { roles: { worker: { rungs: [...rungs, glm] } } }, { [glm]: "gpt-6-sol#xhigh" });
      f.writes.length = 0;
      const read = f.readProfile;
      f.readProfile = (n) => structuredClone(read(n));
      const save = f.save;
      f.save = async (name, patch, treatLikes, shown) => {
        const r = await save(name, patch, treatLikes, shown);
        for (const [rung, like] of Object.entries(treatLikes)) await saveTreatLike(rung, like);
        return r;
      };
    });
    await find("worker glm-5.3 high");
    // enter unticks the unscored rung; enter again maps it, ticking it back: only the treat-like is staged
    await h!.s.press("return", "return");
    await h!.s.type("gpt-6-sol#xhigh");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("treated like gpt-6-sol#xhigh · unsaved");
    expect(h!.s.frame()).toContain("1 unsaved");
    await h!.s.press("ctrl+s", "return");
    await h!.advance(0);
    expect(fx.writes).toHaveLength(1);
    // scored through the saved treat-like, not "unscored" from the catalog read before the save
    expect(h!.s.frame()).not.toContain("unsaved");
    expect(h!.s.frame()).not.toContain("unscored");
    expect(h!.s.frame()).toMatch(/\[x\] high +inferred/);
  });

  it("takes back a picked treat-like and the tick it brought in one undo", async () => {
    await profiles();
    await find("worker glm-5.3 high");
    await h!.s.press("space");
    await h!.s.type("gpt-6-sol#xhigh");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("2 unsaved");
    await h!.s.press("escape", "ctrl+x", "u");
    expect(h!.s.frame()).not.toContain("unsaved");
    expect(h!.app().getState().drafts.default?.past).toHaveLength(0);
  });

  it("says in a toast when the saved profile cannot be read back", async () => {
    const fx = await profiles();
    await find("objective");
    await h!.s.press("return", "ctrl+s");
    // gone once the save has written it (Save reads it again for its preview first)
    const save = fx.save;
    fx.save = async (...a) => {
      const r = await save(...a);
      fx.readProfile = () => {
        throw new Error("profile file vanished");
      };
      return r;
    };
    await h!.s.press("return");
    expect(fx.writes).toEqual(['save default {"objective":"speed"}']);
    expect(h!.s.frame()).toContain("profile file vanished");
  });

  it("says in the save dialog when its preview cannot be read, instead of breaking the screen", async () => {
    const fx = await profiles();
    await find("objective");
    await h!.s.press("return");
    fx.catalog = () => {
      throw new Error("catalog.override.json is not valid JSON");
    };
    await h!.s.press("ctrl+s");
    expect(h!.s.frame()).toContain("Save profile default");
    expect(h!.s.frame()).toContain("catalog.override.json is not valid JSON");
    expect(h!.s.frame()).toContain("[ Cancel ]");
    expect(h!.s.frame()).not.toContain("[ Save ]");
    expect(h!.s.frame()).not.toContain("press q or ctrl+c to quit");
  });

  it("previews the save against the file as it is now, when it changed on disk since the draft began", async () => {
    const fx = await profiles();
    await find("worker access");
    await h!.s.press("return");
    const read = fx.readProfile;
    fx.readProfile = (n) => applyPatch(read(n), { roles: { worker: { access: "read-only" } } });
    await h!.s.press("ctrl+s");
    expect(h!.s.frame()).toMatch(/roles\.worker\.access\s+read-only → full/);
  });

  it("re-reads the file on Save and asks again when the preview changed on disk while open", async () => {
    const fx = await profiles();
    await find("worker access");
    await h!.s.press("return", "ctrl+s");
    expect(h!.s.frame()).toMatch(/roles\.worker\.access\s+workspace-write → full/);
    // another process writes the stored profile: a field the draft touches, and one it does not
    await fx.save("default", { roles: { worker: { access: "read-only" } }, objective: "speed" }, {});
    fx.writes.length = 0;
    await h!.s.press("return");
    expect(fx.writes).toEqual([]);
    expect(h!.s.frame()).toContain("Save profile default");
    expect(h!.s.frame()).toMatch(/roles\.worker\.access\s+read-only → full/);
    expect(h!.s.frame()).toContain("the profile changed on disk — check the changes and choose again");
    await h!.s.press("return");
    expect(fx.writes).toEqual(['save default {"roles":{"worker":{"access":"full"}}}']);
    expect(h!.app().getState().dialogs).toEqual([]);
  });

  it("writes nothing when the profile changes on disk while a staged treat-like is saved, and asks again", async () => {
    const fx = await profiles();
    await find("worker glm-5.3 high");
    await h!.s.press("space");
    await h!.s.type("gpt-6-sol#xhigh");
    await h!.s.press("return", "ctrl+s");
    expect(h!.s.frame()).toContain(`treat ${GLM} like gpt-6-sol#xhigh`);
    // another process writes the rungs while the treat-like waits for the catalog lock
    const theirs = ["codex:gpt-6-luna#high", "codex:gpt-6-sol#medium"];
    const save = fx.save;
    let other = true;
    fx.save = async (name, patch, treatLikes, shown) => {
      if (other) {
        other = false;
        expect((await save(name, { roles: { worker: { rungs: theirs } } }, {})).saved).toBe(true);
        fx.writes.length = 0;
      }
      return save(name, patch, treatLikes, shown);
    };
    await h!.s.press("return");
    expect(fx.writes).toEqual([]);
    expect(fx.readProfile("default").roles?.worker?.rungs).toEqual(theirs);
    expect(h!.app().getState().dialogs).toHaveLength(1);
    expect(h!.s.frame()).toContain("Save profile default");
    // the new preview: the rungs as the other process left them, before the draft's
    expect(h!.s.frame()).toMatch(/roles\.worker\.rungs\s+codex:gpt-6-luna#high, codex:gpt-6-sol#medium → /);
    expect(h!.s.frame()).toContain("the profile changed on disk — check the changes and choose again");
    expect(h!.s.frame()).toContain("[ Save ]");
    await h!.s.press("return");
    expect(fx.writes).toHaveLength(1);
    expect(fx.writes[0]).toContain(`{"${GLM}":"gpt-6-sol#xhigh"}`);
    expect(fx.readProfile("default").roles?.worker?.rungs).toContain(GLM);
    expect(h!.app().getState().dialogs).toEqual([]);
  });

  it("takes no Save in the burst that replaced a changed preview, before the new one is drawn", async () => {
    const fx = await profiles();
    await find("worker access");
    await h!.s.press("return", "ctrl+s");
    await fx.save("default", { roles: { worker: { access: "read-only" } } }, {});
    fx.writes.length = 0;
    await h!.s.burst("return", "return");
    expect(fx.writes).toEqual([]);
    expect(h!.s.frame()).toMatch(/roles\.worker\.access\s+read-only → full/);
    expect(h!.s.frame()).toContain("the profile changed on disk — check the changes and choose again");
    await h!.s.press("return");
    expect(fx.writes).toEqual(['save default {"roles":{"worker":{"access":"full"}}}']);
  });

  it("shows a failed profile read with its fix, not as pending, and retries it on r", async () => {
    let broken = true;
    const fx = await profiles((fx) => {
      const read = fx.profiles;
      fx.profiles = () => {
        if (broken)
          throw new CatherdError("E_CONFIG_INVALID", "config.json is not valid JSON", {
            fix: "fix or delete ~/.catherd/config.json",
          });
        return read();
      };
    });
    const frame = h!.s.frame();
    expect(frame).toContain("could not read the profiles: config.json is not valid JSON");
    expect(frame).toContain("fix: fix or delete ~/.catherd/config.json");
    expect(frame).toContain(" r retry");
    expect(frame).not.toContain("reading the profile…");
    expect(frame).not.toContain("reading the catalog…");
    // r re-reads now; it does not refresh the catalog over the network
    await h!.s.press("r");
    expect(h!.s.frame()).toContain("could not read the profiles");
    broken = false;
    await h!.s.press("r");
    await h!.advance(0);
    expect(h!.s.frame()).toContain("PROFILE default");
    expect(h!.s.frame()).toContain("workspace-write · enforced");
    expect(fx.writes).toEqual([]);
  });

  it("shows a failed read of the profile itself with its fix, not as pending, and retries it on r", async () => {
    let broken = 2;
    const fx = await profiles((fx) => {
      const read = fx.readProfile;
      fx.readProfile = (n) => {
        if (broken > 0)
          throw new CatherdError("E_CONFIG_INVALID", "profiles/default.json is not valid JSON", {
            fix: "fix or delete ~/.catherd/profiles/default.json",
          });
        return read(n);
      };
    });
    const frame = h!.s.frame();
    expect(frame).toContain("could not read the profile default: profiles/default.json is not valid JSON");
    expect(frame).toContain("fix: fix or delete ~/.catherd/profiles/default.json");
    expect(frame).toContain(" r retry");
    expect(frame).not.toContain("reading the profile…");
    // still broken on r: the message stays
    broken = 1;
    await h!.s.press("r");
    expect(h!.s.frame()).toContain("could not read the profile default");
    expect(fx.writes).toEqual([]);
    broken = 0;
    await h!.s.press("r");
    await h!.advance(0);
    expect(h!.s.frame()).toContain("PROFILE default");
    expect(h!.s.frame()).toContain("workspace-write · enforced");
  });

  it("reads a profile that failed to read again on the next poll, without a key", async () => {
    let broken = true;
    await profiles((fx) => {
      const read = fx.readProfile;
      fx.readProfile = (n) => {
        if (broken) throw new Error("profiles/default.json is unreadable");
        return read(n);
      };
    });
    expect(h!.s.frame()).toContain("could not read the profile default: profiles/default.json is unreadable");
    broken = false;
    await h!.advance(RUNS_EVERY_MS);
    await h!.advance(0);
    expect(h!.s.frame()).toContain("workspace-write · enforced");
  });

  it("recovers from a failed profile read on the next poll, without a key", async () => {
    let broken = true;
    await profiles((fx) => {
      const read = fx.profiles;
      fx.profiles = () => {
        if (broken) throw new CatherdError("E_IO_PATH", "profiles/ is unreadable", { fix: "chmod u+rx it" });
        return read();
      };
    });
    expect(h!.s.frame()).toContain("could not read the profiles: profiles/ is unreadable");
    broken = false;
    await h!.advance(RUNS_EVERY_MS);
    await h!.advance(0);
    expect(h!.s.frame()).toContain("workspace-write · enforced");
  });

  it("says when a later profiles read fails, keeps the draft editable, and re-reads on ctrl+x l and a", async () => {
    let broken = false;
    let reads = 0;
    const fx = await profiles((fx) => {
      const read = fx.profiles;
      fx.profiles = () => {
        reads++;
        if (broken)
          throw new CatherdError("E_CONFIG_INVALID", "config.json is not valid JSON", {
            fix: "fix or delete ~/.catherd/config.json",
          });
        return read();
      };
    });
    expect(h!.s.frame()).toContain("workspace-write · enforced");
    broken = true;
    await h!.advance(RUNS_EVERY_MS);
    const frame = h!.s.frame();
    expect(frame.split("\n")[0]).toContain("PROFILE default");
    expect(frame.split("\n")[1]).toContain(
      "✗ could not read the profiles again: config.json is not valid JSON · showing the last good read",
    );
    expect(frame.split("\n")[2]).toContain("fix: fix or delete ~/.catherd/config.json");
    // the open draft stays editable
    await find("worker access");
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("full · enforced");
    expect(h!.s.frame()).toContain("1 unsaved");
    // the picker and the activate prompt read the profiles again rather than act on the kept read
    const before = reads;
    await h!.s.press("ctrl+x", "l");
    expect(reads).toBe(before + 1);
    expect(h!.app().getState().dialogs).toEqual([]);
    await h!.s.press("a");
    expect(reads).toBe(before + 2);
    expect(h!.app().getState().dialogs).toEqual([]);
    expect(fx.writes).toEqual([]);
    broken = false;
    await h!.advance(RUNS_EVERY_MS);
    expect(h!.s.frame()).not.toContain("could not read the profiles again");
    expect(h!.s.frame()).not.toContain("fix: fix or delete ~/.catherd/config.json");
    await h!.s.press("ctrl+x", "l");
    expect(h!.s.frame()).toContain("Profiles");
    expect(h!.app().getState().dialogs).toHaveLength(1);
  });

  it("shows a failed catalog read with its fix, and re-reads it on r", async () => {
    let broken = true;
    const fx = await profiles((fx) => {
      const read = fx.catalog;
      fx.catalog = (b) => {
        if (broken)
          throw new CatherdError("E_CONFIG_INVALID", "catalog.override.json is not valid JSON", {
            fix: "fix or delete ~/.catherd/catalog.override.json",
          });
        return read(b);
      };
    });
    const frame = h!.s.frame();
    expect(frame).toContain("could not read the catalog: catalog.override.json is not valid JSON");
    expect(frame).toContain("fix: fix or delete ~/.catherd/catalog.override.json");
    expect(frame).toContain(" r retry");
    broken = false;
    await h!.s.press("r");
    await h!.advance(0);
    expect(h!.s.frame()).toContain("workspace-write · enforced");
    expect(fx.writes).toEqual([]);
  });

  it("saves once when enter is pressed again while the save is still writing", async () => {
    const fx = await profiles();
    await find("objective");
    await h!.s.press("return", "ctrl+s");
    const save = fx.save;
    let finish = () => {};
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    let calls = 0;
    fx.save = async (...a) => {
      calls++;
      await gate;
      return save(...a);
    };
    await h!.s.press("return", "return");
    await h!.run(async () => {
      finish();
      await gate;
    });
    await h!.advance(0);
    expect(calls).toBe(1);
    expect(fx.writes).toEqual(['save default {"objective":"speed"}']);
    expect(h!.app().getState().dialogs).toEqual([]);
  });

  it("keeps the save dialog open while the save writes: esc does nothing, and the draft is clean after", async () => {
    const fx = await profiles();
    await find("objective");
    await h!.s.press("return", "ctrl+s");
    const save = fx.save;
    let finish = () => {};
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    fx.save = async (...a) => {
      await gate;
      return save(...a);
    };
    await h!.s.press("return");
    expect(h!.s.frame()).toContain("saving…");
    expect(h!.s.frame()).not.toContain("[ Save ]");
    await h!.s.press("escape", "escape");
    expect(h!.app().getState().dialogs).toHaveLength(1);
    expect(h!.s.frame()).toContain("Save profile default");
    await h!.run(async () => {
      finish();
      await gate;
    });
    await h!.advance(0);
    expect(fx.writes).toEqual(['save default {"objective":"speed"}']);
    expect(h!.app().getState().dialogs).toEqual([]);
    expect(h!.s.frame()).not.toContain("unsaved");
    expect(h!.app().getState().drafts.default?.base.objective).toBe("speed");
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

describe("keys that land in one tick (Review Focus 2)", () => {
  it("moves twice on `jj ` and toggles the row it moved to, not the one drawn", async () => {
    await profiles();
    await h!.s.burst("jj ");
    const roles = h!.app().getState().drafts.default?.doc.roles;
    expect(roles?.architect?.enabled).toBe(true);
    expect(roles?.worker?.enabled).toBe(false);
  });

  it("submits the name typed into the prompt in the same tick as enter", async () => {
    const fx = await profiles();
    await h!.s.press("ctrl+x", "n");
    await h!.s.burst("cheap", "return");
    expect(fx.writes).toEqual(["create cheap"]);
  });

  it("submits the number typed into the editor in the same tick as enter", async () => {
    const fx = await profiles();
    await find("budget usd");
    await h!.s.press("return");
    await h!.s.burst("5", "return");
    await h!.s.press("ctrl+s", "return");
    expect(fx.writes).toEqual(['save default {"budget":{"usd":5}}']);
  });

  it("puts the letters typed right after / in the filter, and runs none of them", async () => {
    const fx = await profiles((f) => f.create("cheap"));
    await h!.s.burst("/", "ab");
    expect(h!.s.frame()).toContain(" / ab");
    expect(h!.s.frame()).not.toContain("already active");
    expect(h!.app().getState().dialogs).toEqual([]);
    expect(fx.writes).toEqual(["create cheap"]);
  });

  it("opens the name prompt and types into it in the same tick", async () => {
    const fx = await profiles();
    await h!.s.burst("ctrl+x", "n", "cheap", "return");
    expect(fx.writes).toEqual(["create cheap"]);
  });
});
