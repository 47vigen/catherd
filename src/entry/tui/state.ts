import {
  applyPatch,
  diffProfiles,
  type ProfileDoc,
  type ProfilePatch,
  resolveProfile,
} from "../../domain/profile.ts";
import type { Role } from "../../domain/roles.ts";

/** Spec §9.1: one app, three tabs. */
export const TABS = ["status", "profiles", "runs"] as const;
export type Tab = (typeof TABS)[number];

/** What a draft can undo to: the edited document and the treat-likes staged with it. */
export interface Snapshot {
  doc: ProfileDoc;
  /** rung → the scored rung it is treated like; written to catalog.override.json on save */
  treatLikes: Record<string, string>;
}

/** Spec §9.2: edits are staged per profile and touch nothing on disk until a save. */
export interface Draft extends Snapshot {
  name: string;
  /** the document as it was read, which a save diffs against */
  base: ProfileDoc;
  past: Snapshot[];
  future: Snapshot[];
}

/** The number fields a value editor sets. */
export const NUMBER_PATHS = [
  "budget.minutes",
  "budget.tokens",
  "budget.usd",
  "timeouts.idleMin",
  "timeouts.wallMin",
] as const;
export type NumberPath = (typeof NUMBER_PATHS)[number];

/** Why a dialog is open, so the one handler for that purpose runs when it is answered. */
export type Purpose =
  | { type: "palette" }
  | { type: "help" }
  | { type: "quit" }
  | { type: "save"; name: string }
  | { type: "activate"; name: string }
  | { type: "revert"; name: string }
  | { type: "profiles" }
  | { type: "new" }
  | { type: "copy"; from: string }
  | { type: "number"; path: NumberPath }
  | { type: "start"; role: Role }
  | { type: "treatLike"; rung: string; role: Role | null }
  | { type: "failover"; rung: string }
  | { type: "stories" };

export interface SelectOption {
  value: string;
  title: string;
  /** options with a group are shown under its heading, in the order the groups first appear */
  group?: string;
  /** muted text on the right: a key, a mark, a CLI command */
  detail?: string;
  /** the value in force now, marked `●` */
  current?: boolean;
}

export type Dialog =
  | {
      kind: "select";
      purpose: Purpose;
      title: string;
      options: SelectOption[];
      /** Suggested options, shown first while the filter is empty */
      suggested?: string[];
      /** offers ctrl+d, pressed twice, to delete the selected option */
      deletable?: boolean;
      /** the one muted line shown when there is nothing to choose */
      empty: string;
    }
  | {
      kind: "confirm";
      purpose: Purpose;
      title: string;
      message: string[];
      yes: string;
      no: string;
      /** a destructive confirm starts on its "no" button */
      destructive: boolean;
    }
  | { kind: "prompt"; purpose: Purpose; title: string; label: string; value: string; error: string | null }
  | { kind: "save"; purpose: { type: "save"; name: string }; error: string | null };

/** A double press waiting for its second key (spec §9.2: ctrl+c when dirty, ctrl+d to delete or cancel). */
export interface Armed {
  what: "interrupt" | "delete" | "cancel";
  target: string;
  at: number;
}

/** How long the second press of each double press may wait. */
export const ARM_MS: Record<Armed["what"], number> = { interrupt: 1_500, delete: 5_000, cancel: 5_000 };

export const HISTORY_LIMIT = 100;

export interface AppState {
  tab: Tab;
  /** the profile the Profiles tab shows; null until one is read */
  profile: string | null;
  drafts: Record<string, Draft>;
  /** the open dialogs; only the top one is drawn and takes keys */
  dialogs: Dialog[];
  /** the run the Runs tab has open; null shows the list */
  run: string | null;
  paused: boolean;
  armed: Armed | null;
}

export type Action =
  | { type: "tab"; tab: Tab }
  | { type: "show"; name: string; doc: ProfileDoc }
  | { type: "edit"; patch: ProfilePatch }
  | { type: "treatLike"; rung: string; like: string | null }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "revert"; name: string }
  | { type: "saved"; name: string; doc: ProfileDoc }
  | { type: "forget"; name: string }
  | { type: "open"; dialog: Dialog }
  | { type: "replace"; dialog: Dialog }
  | { type: "close" }
  | { type: "input"; value: string }
  | { type: "invalid"; error: string | null }
  | { type: "run"; id: string | null }
  | { type: "pause" }
  | { type: "arm"; what: Armed["what"]; target: string; at: number }
  | { type: "disarm" };

export const initialState = (tab: Tab = "status"): AppState => ({
  tab,
  profile: null,
  drafts: {},
  dialogs: [],
  run: null,
  paused: false,
  armed: null,
});

const fresh = (name: string, doc: ProfileDoc): Draft => ({
  name,
  base: doc,
  doc,
  treatLikes: {},
  past: [],
  future: [],
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The draft the Profiles tab shows, if any. */
export const currentDraft = (s: AppState): Draft | null => (s.profile ? (s.drafts[s.profile] ?? null) : null);

/** Changes staged in a draft: each changed field of the profile, and each staged treat-like. */
export function dirtyCount(d: Draft): number {
  const fields = diffProfiles(resolveProfile(d.base, d.name), resolveProfile(d.doc, d.name)).length;
  return fields + Object.keys(d.treatLikes).length;
}

export const totalDirty = (s: AppState): number =>
  Object.values(s.drafts).reduce((n, d) => n + dirtyCount(d), 0);

/** Whether the second press of `what` on `target` at `now` completes the double press. */
export const isArmed = (s: AppState, what: Armed["what"], target: string, now: number): boolean =>
  s.armed !== null && s.armed.what === what && s.armed.target === target && now - s.armed.at <= ARM_MS[what];

/** A draft moved to `next`, the old state kept for undo; a change to nothing is no change. */
function step(d: Draft, next: Snapshot): Draft {
  if (same(next.doc, d.doc) && same(next.treatLikes, d.treatLikes)) return d;
  return {
    ...d,
    ...next,
    past: [...d.past, { doc: d.doc, treatLikes: d.treatLikes }].slice(-HISTORY_LIMIT),
    future: [],
  };
}

function withDraft(s: AppState, name: string | null, f: (d: Draft) => Draft): AppState {
  const d = name ? s.drafts[name] : undefined;
  if (!d) return s;
  const next = f(d);
  return next === d ? s : { ...s, drafts: { ...s.drafts, [d.name]: next } };
}

/** Spec §9.4 `state.ts`: the pure reducer for tabs, drafts and their history, dialogs and armed keys. */
export function reduce(s: AppState, a: Action): AppState {
  switch (a.type) {
    case "tab":
      return { ...s, tab: a.tab, armed: null };
    case "show":
      return {
        ...s,
        tab: "profiles",
        profile: a.name,
        drafts: s.drafts[a.name] ? s.drafts : { ...s.drafts, [a.name]: fresh(a.name, a.doc) },
      };
    case "edit":
      return withDraft(s, s.profile, (d) =>
        step(d, { doc: applyPatch(d.doc, a.patch), treatLikes: d.treatLikes }),
      );
    case "treatLike":
      return withDraft(s, s.profile, (d) => {
        const treatLikes = { ...d.treatLikes };
        if (a.like === null) delete treatLikes[a.rung];
        else treatLikes[a.rung] = a.like;
        return step(d, { doc: d.doc, treatLikes });
      });
    case "undo":
      return withDraft(s, s.profile, (d) => {
        const prev = d.past.at(-1);
        if (!prev) return d;
        return {
          ...d,
          ...prev,
          past: d.past.slice(0, -1),
          future: [{ doc: d.doc, treatLikes: d.treatLikes }, ...d.future],
        };
      });
    case "redo":
      return withDraft(s, s.profile, (d) => {
        const next = d.future[0];
        if (!next) return d;
        return {
          ...d,
          ...next,
          past: [...d.past, { doc: d.doc, treatLikes: d.treatLikes }],
          future: d.future.slice(1),
        };
      });
    case "revert":
      return withDraft(s, a.name, (d) => step(d, { doc: d.base, treatLikes: {} }));
    case "saved":
      return { ...s, drafts: { ...s.drafts, [a.name]: fresh(a.name, a.doc) } };
    case "forget": {
      const { [a.name]: _gone, ...drafts } = s.drafts;
      return { ...s, drafts, profile: s.profile === a.name ? null : s.profile };
    }
    case "open":
      return { ...s, dialogs: [...s.dialogs, a.dialog], armed: null };
    case "replace":
      return { ...s, dialogs: [...s.dialogs.slice(0, -1), a.dialog], armed: null };
    case "close":
      return { ...s, dialogs: s.dialogs.slice(0, -1), armed: null };
    case "input":
    case "invalid": {
      const top = s.dialogs.at(-1);
      if (!top) return s;
      let next: Dialog = top;
      if (top.kind === "prompt")
        next = a.type === "input" ? { ...top, value: a.value, error: null } : { ...top, error: a.error };
      else if (top.kind === "save" && a.type === "invalid") next = { ...top, error: a.error };
      return next === top ? s : { ...s, dialogs: [...s.dialogs.slice(0, -1), next] };
    }
    case "run":
      return { ...s, run: a.id, armed: null };
    case "pause":
      return { ...s, paused: !s.paused };
    case "arm":
      return { ...s, armed: { what: a.what, target: a.target, at: a.at } };
    case "disarm":
      return s.armed ? { ...s, armed: null } : s;
  }
}
