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

  it("opens and leaves a run, and pauses", () => {
    const s = run(initialState("runs"), { type: "run", id: "r1" }, { type: "pause" });
    expect([s.run, s.paused]).toEqual(["r1", true]);
    expect(run(s, { type: "run", id: null }, { type: "pause" })).toMatchObject({ run: null, paused: false });
  });
});
