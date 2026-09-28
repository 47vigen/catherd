import {
  applyPatch,
  diffProfiles,
  patchBetween,
  type ProfileDoc,
  type ProfilePatch,
  resolveProfile,
} from "../../domain/profile.ts";
import type { Role } from "../../domain/roles.ts";

/** Spec §9.1: one app, three tabs. */
export const TABS = ["status", "profiles", "runs"] as const;
export type Tab = (typeof TABS)[number];

/** What a draft can undo to: the edited document and the treat-likes staged with it. */
interface Snapshot {
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
const NUMBER_PATHS = [
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
  /** `repo`: the scope the prompt shows, the bound repo or null for the global profile */
  | { type: "activate"; name: string; repo: string | null }
  | { type: "revert"; name: string }
  | { type: "profiles" }
  | { type: "new" }
  | { type: "copy"; from: string }
  | { type: "number"; path: NumberPath }
  | { type: "start"; role: Role }
  | { type: "treatLike"; rung: string; role: Role | null }
  | { type: "failover"; rung: string }
  /** spec 1.2 §9: each source's age and last error, after `r` synced them */
  | { type: "sources" }
  /** spec 1.2 §9: a rung's values with confidence and source, and its runs */
  | { type: "rung"; rung: string }
  | { type: "stories" };

export interface SelectOption {
  value: string;
  title: string;
  /** options with a group are shown under its heading, in the order the groups first appear */
  group?: string;
  /** muted text after the title, in a column of its own: a key, a mark */
  detail?: string;
  /** a second muted column after the detail (the command's CLI twin); dropped when it does not fit */
  cli?: string;
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
  | {
      kind: "save";
      purpose: { type: "save"; name: string };
      error: string | null;
      /** a save is writing: the dialog shows "saving…", takes no answer and cannot be closed */
      saving?: boolean;
    };

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
  /** spec §4: the session the Runs tab has open (`key` null: "earlier runs"); null shows the sessions */
  session: { key: string | null } | null;
  /** the role the open session shows, by its dispatch */
  role: { run: string; dispatchId: string } | null;
  /** spec 1.1 §10: the milestone the open session shows, its digest */
  milestone: { run: string; name: string } | null;
  paused: boolean;
  armed: Armed | null;
}

export type Action =
  | { type: "tab"; tab: Tab }
  | { type: "show"; name: string; doc: ProfileDoc }
  | { type: "edit"; patch: ProfilePatch }
  /** `patch` (ticking the rung) lands in the same undo step as the treat-like */
  | { type: "treatLike"; rung: string; like: string | null; patch?: ProfilePatch }
  | { type: "undo" }
  | { type: "redo" }
  /** `doc`: the profile as it is on disk now, the new base (else the draft's own base) */
  | { type: "revert"; name: string; doc?: ProfileDoc }
  /** `from` is the draft as the save began; edits made while it wrote stay staged over `doc` */
  | { type: "saved"; name: string; doc: ProfileDoc; from?: Snapshot }
  | { type: "forget"; name: string }
  | { type: "open"; dialog: Dialog }
  | { type: "replace"; dialog: Dialog }
  | { type: "close" }
  | { type: "saving"; name: string; on: boolean }
  | { type: "input"; value: string }
  | { type: "invalid"; error: string | null }
  /** opens a session of the Runs tab (`key` null: "earlier runs") */
  | { type: "session"; key: string | null }
  /** opens one role of the open session */
  | { type: "role"; run: string; dispatchId: string }
  /** opens one milestone of the open session, on its digest */
  | { type: "milestone"; run: string; name: string }
  /** the Runs tab goes back one level: a milestone or a role to its session, a session to the list */
  | { type: "up" }
  | { type: "pause" }
  | { type: "arm"; what: Armed["what"]; target: string; at: number }
  | { type: "disarm" };

export const initialState = (tab: Tab = "status"): AppState => ({
  tab,
  profile: null,
  drafts: {},
  dialogs: [],
  session: null,
  role: null,
  milestone: null,
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
const isStaged = (d: Draft | undefined): boolean => d !== undefined && dirtyCount(d) > 0;

export function dirtyCount(d: Draft): number {
  const fields = diffProfiles(resolveProfile(d.base, d.name), resolveProfile(d.doc, d.name)).length;
  return fields + Object.keys(d.treatLikes).length;
}

export const totalDirty = (s: AppState): number =>
  Object.values(s.drafts).reduce((n, d) => n + dirtyCount(d), 0);

/** Whether a save is writing: its dialog stays open, and the TUI does not quit, until it settles. */
export const isSaving = (s: AppState): boolean =>
  s.dialogs.some((d) => d.kind === "save" && d.saving === true);

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
        // Keep only a draft with staged changes; a clean one restarts from the file just read.
        drafts: isStaged(s.drafts[a.name]) ? s.drafts : { ...s.drafts, [a.name]: fresh(a.name, a.doc) },
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
        return step(d, { doc: a.patch ? applyPatch(d.doc, a.patch) : d.doc, treatLikes });
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
      return withDraft(s, a.name, (d) => {
        const base = a.doc ?? d.base;
        if (same(base, d.base)) return step(d, { doc: d.base, treatLikes: {} });
        // another process saved the profile since the draft opened: what is saved now is the new base, and
        // the history (with this revert's undo step) keeps each staged change, now over that base. A step
        // that cannot be carried over (a hand-written rung no patch accepts) is dropped: a reducer that
        // throws from a key handler would end the TUI
        const moved = (x: Snapshot): Snapshot[] => {
          try {
            return [{ ...x, doc: applyPatch(base, patchBetween(d.base, x.doc)) }];
          } catch {
            return [];
          }
        };
        return {
          ...d,
          base,
          doc: base,
          treatLikes: {},
          past: [...d.past, { doc: d.doc, treatLikes: d.treatLikes }].flatMap(moved).slice(-HISTORY_LIMIT),
          future: [],
        };
      });
    case "saved": {
      const d = s.drafts[a.name];
      const from = a.from;
      if (!from || !d || (same(d.doc, from.doc) && same(d.treatLikes, from.treatLikes)))
        return { ...s, drafts: { ...s.drafts, [a.name]: fresh(a.name, a.doc) } };
      // edited while the save wrote: the saved file is the new base, and the newer edits stay staged over it
      const treatLikes = Object.fromEntries(
        Object.entries(d.treatLikes).filter(([rung, like]) => from.treatLikes[rung] !== like),
      );
      const doc = applyPatch(a.doc, patchBetween(from.doc, d.doc));
      return { ...s, drafts: { ...s.drafts, [a.name]: { ...fresh(a.name, a.doc), doc, treatLikes } } };
    }
    case "forget": {
      const { [a.name]: _gone, ...drafts } = s.drafts;
      return { ...s, drafts, profile: s.profile === a.name ? null : s.profile };
    }
    case "open":
      return { ...s, dialogs: [...s.dialogs, a.dialog], armed: null };
    case "replace":
      return { ...s, dialogs: [...s.dialogs.slice(0, -1), a.dialog], armed: null };
    case "close": {
      const top = s.dialogs.at(-1);
      if (top?.kind === "save" && top.saving) return s;
      return { ...s, dialogs: s.dialogs.slice(0, -1), armed: null };
    }
    case "saving": {
      const at = s.dialogs.findIndex((d) => d.kind === "save" && d.purpose.name === a.name);
      const d = s.dialogs[at];
      if (d?.kind !== "save" || (d.saving === true) === a.on) return s;
      const dialogs = [...s.dialogs];
      dialogs[at] = { ...d, saving: a.on };
      return { ...s, dialogs };
    }
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
    case "session":
      return { ...s, session: { key: a.key }, role: null, milestone: null, armed: null };
    case "role":
      return { ...s, role: { run: a.run, dispatchId: a.dispatchId }, milestone: null, armed: null };
    case "milestone":
      return { ...s, milestone: { run: a.run, name: a.name }, role: null, armed: null };
    case "up":
      if (s.milestone) return { ...s, milestone: null, armed: null };
      return s.role ? { ...s, role: null, armed: null } : { ...s, session: null, armed: null };
    case "pause":
      return { ...s, paused: !s.paused };
    case "arm":
      return { ...s, armed: { what: a.what, target: a.target, at: a.at } };
    case "disarm":
      return s.armed ? { ...s, armed: null } : s;
  }
}
