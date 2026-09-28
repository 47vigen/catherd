import { describe, expect, it } from "bun:test";
import { defaultProfileDoc } from "../../../src/domain/profile.ts";
import {
  type Action,
  type AppState,
  currentDraft,
  dirtyCount,
  type Dialog,
  HISTORY_LIMIT,
  initialState,
  isArmed,
  isSaving,
  reduce,
  totalDirty,
} from "../../../src/entry/tui/state.ts";

const run = (s: AppState, ...actions: Action[]) => actions.reduce(reduce, s);
const shown = () => run(initialState(), { type: "show", name: "default", doc: defaultProfileDoc() });
const confirm: Dialog = {
  kind: "confirm",
  purpose: { type: "quit" },
  title: "Quit?",
  message: [],
  yes: "Quit",
  no: "Stay",
  destructive: true,
};

describe("drafts (spec §9.2: edits are staged)", () => {
  it("stages an edit in the shown profile's draft and counts it", () => {
    const s = run(shown(), { type: "edit", patch: { budget: { usd: 5 }, objective: "speed" } });
    const d = currentDraft(s);
    expect(d?.doc.budget).toEqual({ usd: 5 });
    expect(d?.base.budget).toEqual({});
    expect(dirtyCount(d!)).toBe(2);
    expect(s.tab).toBe("profiles");
  });

  it("counts a staged treat-like as a change, and takes one back with null", () => {
    let s = run(shown(), {
      type: "treatLike",
      rung: "opencode:opencode-go/glm-6#default",
      like: "gpt-6-sol#medium",
    });
    expect(totalDirty(s)).toBe(1);
    s = run(s, { type: "treatLike", rung: "opencode:opencode-go/glm-6#default", like: null });
    expect(totalDirty(s)).toBe(0);
  });

  it("undoes and redoes edits and treat-likes in order, and a new edit clears redo", () => {
    let s = run(
      shown(),
      { type: "edit", patch: { objective: "speed" } },
      { type: "treatLike", rung: "r#x", like: "gpt-6-sol#high" },
      { type: "undo" },
    );
    expect(currentDraft(s)?.treatLikes).toEqual({});
    expect(currentDraft(s)?.doc.objective).toBe("speed");
    s = run(s, { type: "undo" });
    expect(currentDraft(s)?.doc.objective).toBe("cost");
    s = run(s, { type: "redo" });
    expect(currentDraft(s)?.doc.objective).toBe("speed");
    s = run(s, { type: "edit", patch: { budget: { minutes: 3 } } }, { type: "redo" });
    expect(currentDraft(s)?.treatLikes).toEqual({});
    expect(currentDraft(s)?.future).toEqual([]);
  });

  it("does not record an edit that changes nothing, and caps the history", () => {
    let s = run(shown(), { type: "edit", patch: { objective: "cost" } });
    expect(currentDraft(s)?.past).toHaveLength(0);
    for (let i = 1; i <= HISTORY_LIMIT + 5; i++)
      s = run(s, { type: "edit", patch: { budget: { minutes: i } } });
    expect(currentDraft(s)?.past).toHaveLength(HISTORY_LIMIT);
  });

  it("keeps a draft when its profile is shown again, and starts over after a save", () => {
    let s = run(shown(), { type: "edit", patch: { objective: "speed" } }, { type: "tab", tab: "status" });
    s = run(s, { type: "show", name: "default", doc: defaultProfileDoc() });
    expect(currentDraft(s)?.doc.objective).toBe("speed");
    const saved = { ...defaultProfileDoc(), objective: "speed" as const };
    s = run(s, { type: "saved", name: "default", doc: saved });
    expect(dirtyCount(currentDraft(s)!)).toBe(0);
    expect(currentDraft(s)?.past).toEqual([]);
  });

  it("rebases a draft edited while its save wrote: the saved file is its base, the newer edits stay", () => {
    let s = run(shown(), { type: "edit", patch: { objective: "speed" } });
    const from = { doc: currentDraft(s)!.doc, treatLikes: currentDraft(s)!.treatLikes };
    s = run(
      s,
      { type: "edit", patch: { budget: { usd: 5 } } },
      { type: "treatLike", rung: "r#x", like: "gpt-6-sol#high" },
    );
    const saved = { ...defaultProfileDoc(), objective: "speed" as const };
    s = run(s, { type: "saved", name: "default", doc: saved, from });
    const d = currentDraft(s)!;
    expect(d.base).toEqual(saved);
    expect(d.doc.objective).toBe("speed");
    expect(d.doc.budget).toEqual({ usd: 5 });
    expect(d.treatLikes).toEqual({ "r#x": "gpt-6-sol#high" });
    expect(dirtyCount(d)).toBe(2);
  });

  it("restarts a clean draft from the file shown again, so a change made elsewhere shows", () => {
    let s = run(shown(), { type: "tab", tab: "status" });
    const newer = { ...defaultProfileDoc(), objective: "speed" as const };
    s = run(s, { type: "show", name: "default", doc: newer });
    expect(currentDraft(s)?.base.objective).toBe("speed");
    expect(dirtyCount(currentDraft(s)!)).toBe(0);
  });

  it("reverts as one undoable step, and forgets a deleted profile's draft", () => {
    let s = run(
      shown(),
      { type: "edit", patch: { objective: "speed" } },
      { type: "revert", name: "default" },
    );
    expect(totalDirty(s)).toBe(0);
    s = run(s, { type: "undo" });
    expect(totalDirty(s)).toBe(1);
    s = run(s, { type: "forget", name: "default" });
    expect([s.profile, s.drafts]).toEqual([null, {}]);
  });

  it("reverts to the profile on disk even when a staged step holds a rung no patch accepts", () => {
    const doc = defaultProfileDoc();
    const bogus = { ...doc, roles: { ...doc.roles, worker: { ...doc.roles?.worker, rungs: ["bogus"] } } };
    const theirs = { ...bogus, objective: "speed" as const };
    let s = run(initialState(), { type: "show", name: "default", doc: bogus });
    s = run(s, { type: "edit", patch: { roles: { worker: { rungs: ["bogus", "codex:gpt-6-sol#high"] } } } });
    s = run(s, { type: "revert", name: "default", doc: theirs });
    expect(currentDraft(s)?.doc.objective).toBe("speed");
  });

  it("reverts to the profile as it is on disk now, and undo stages the changes again over it", () => {
    const theirs = { ...defaultProfileDoc(), objective: "speed" as const };
    let s = run(
      shown(),
      { type: "edit", patch: { budget: { usd: 5 } } },
      { type: "revert", name: "default", doc: theirs },
    );
    let d = currentDraft(s)!;
    expect([d.base.objective, d.doc.objective, d.doc.budget?.usd, dirtyCount(d)]).toEqual([
      "speed",
      "speed",
      undefined,
      0,
    ]);
    s = run(s, { type: "undo" });
    d = currentDraft(s)!;
    // the staged cap comes back over what is saved now: the objective another process saved stays
    expect([d.doc.objective, d.doc.budget?.usd, dirtyCount(d)]).toEqual(["speed", 5, 1]);
    s = run(s, { type: "redo" });
    expect(dirtyCount(currentDraft(s)!)).toBe(0);
  });

  it("ignores edits with no profile shown", () => {
    const s = initialState();
    expect(run(s, { type: "edit", patch: { objective: "speed" } }, { type: "undo" })).toBe(s);
  });
});

describe("dialogs and armed keys", () => {
  it("stacks, replaces and closes dialogs, and a prompt keeps its value and error", () => {
    const prompt: Dialog = {
      kind: "prompt",
      purpose: { type: "new" },
      title: "New profile",
      label: "name",
      value: "",
      error: null,
    };
    let s = run(initialState(), { type: "open", dialog: confirm }, { type: "open", dialog: prompt });
    s = run(s, { type: "input", value: "Fast" }, { type: "invalid", error: "lowercase only" });
    expect(s.dialogs.at(-1)).toMatchObject({ value: "Fast", error: "lowercase only" });
    s = run(s, { type: "input", value: "fast" });
    expect(s.dialogs.at(-1)).toMatchObject({ value: "fast", error: null });
    s = run(s, { type: "close" });
    expect(s.dialogs).toEqual([confirm]);
    s = run(s, { type: "replace", dialog: prompt }, { type: "close" });
    expect(s.dialogs).toEqual([]);
  });

  it("does not close a save dialog while its save writes, and closes it once the write settles", () => {
    const save: Dialog = { kind: "save", purpose: { type: "save", name: "default" }, error: null };
    let s = run(
      initialState(),
      { type: "open", dialog: save },
      { type: "saving", name: "default", on: true },
    );
    expect(isSaving(s)).toBe(true);
    expect(run(s, { type: "close" }).dialogs).toHaveLength(1);
    s = run(s, { type: "saving", name: "default", on: false }, { type: "close" });
    expect(s.dialogs).toEqual([]);
    expect(isSaving(s)).toBe(false);
  });

  it("arms a double press for its window only, on its own target", () => {
    const s = run(initialState(), { type: "arm", what: "delete", target: "fast", at: 1_000 });
    expect(isArmed(s, "delete", "fast", 5_999)).toBe(true);
    expect(isArmed(s, "delete", "fast", 6_001)).toBe(false);
    expect(isArmed(s, "delete", "cheap", 2_000)).toBe(false);
    expect(isArmed(s, "cancel", "fast", 2_000)).toBe(false);
    const i = run(initialState(), { type: "arm", what: "interrupt", target: "app", at: 0 });
    expect([isArmed(i, "interrupt", "app", 1_500), isArmed(i, "interrupt", "app", 1_501)]).toEqual([
      true,
      false,
    ]);
    expect(run(s, { type: "tab", tab: "runs" }).armed).toBeNull();
    expect(run(s, { type: "open", dialog: confirm }).armed).toBeNull();
  });

  it("opens a session, then a role, goes back one level at a time, and pauses (spec §4)", () => {
    const s = run(
      initialState("runs"),
      { type: "session", key: "s1" },
      { type: "role", run: "r1", dispatchId: "d1" },
      { type: "pause" },
    );
    expect([s.session, s.role, s.paused]).toEqual([{ key: "s1" }, { run: "r1", dispatchId: "d1" }, true]);
    const up = run(s, { type: "up" });
    expect([up.session, up.role]).toEqual([{ key: "s1" }, null]);
    expect(run(up, { type: "up" }, { type: "pause" })).toMatchObject({
      session: null,
      role: null,
      paused: false,
    });
    // "earlier runs" is a session too, with no key
    expect(run(initialState("runs"), { type: "session", key: null }).session).toEqual({ key: null });
  });

  it("opens a milestone of the session; up goes back to the session, and another session closes it", () => {
    const s = run(
      initialState("runs"),
      { type: "session", key: "s1" },
      { type: "role", run: "r1", dispatchId: "d1" },
      { type: "arm", what: "cancel", target: "r1/x", at: 0 },
      { type: "milestone", run: "r1", name: "M0" },
    );
    expect([s.session, s.milestone, s.role, s.armed]).toEqual([
      { key: "s1" },
      { run: "r1", name: "M0" },
      null,
      null,
    ]);
    const up = run(s, { type: "up" });
    expect([up.session, up.milestone]).toEqual([{ key: "s1" }, null]);
    expect(run(s, { type: "session", key: "s2" }).milestone).toBeNull();
    expect(initialState("runs").milestone).toBeNull();
  });
});
