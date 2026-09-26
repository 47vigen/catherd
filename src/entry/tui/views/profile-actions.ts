import { isDeepStrictEqual } from "node:util";
import { isCatherdError } from "../../../domain/errors.ts";
import { PROFILE_NAME, patchBetween, type ProfileDoc } from "../../../domain/profile.ts";
import { CHANGED_ON_DISK } from "../effects.ts";
import { type AppApi, useApp, useDialogHandler } from "../providers/app.tsx";
import { type Data, useData } from "../providers/data.tsx";
import { errorToast } from "../providers/toast.tsx";
import { currentDraft, dirtyCount, isSaving } from "../state.ts";
import { plural } from "../text.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const fail = (app: AppApi, e: unknown) => app.toast(errorToast(e));

/**
 * Shows a profile in the Profiles tab, starting its draft from disk unless one is staged. A read that
 * fails is a toast, or with `quiet` only returned (the caller shows it); null when it was shown.
 */
export function showProfile(app: AppApi, name: string, o: { quiet?: boolean } = {}): unknown {
  try {
    app.dispatch({ type: "show", name, doc: app.effects.readProfile(name) });
    return null;
  } catch (e) {
    if (!o.quiet) fail(app, e);
    return e;
  }
}

/**
 * The profiles as they are now: the poll's value while its last read was good, else a read of them now
 * (which throws as the poll's did, until the file is fixed); a good one also brings the poll up to date.
 */
function fresh(app: AppApi, data: Data): NonNullable<Data["profiles"]["value"]> {
  if (data.profiles.value && data.profiles.error === null) return data.profiles.value;
  const p = app.effects.profiles();
  if (data.profiles.error !== null) data.profiles.refresh();
  return p;
}

/** The profile list (`<leader>l`): enter shows one, ctrl+d twice deletes one. */
export function openProfileList(app: AppApi, data: Data): void {
  let p: NonNullable<Data["profiles"]["value"]>;
  try {
    // the poll has not read them yet, or its last read failed (a kept value would be stale): read them now;
    // a key handler's throw would end the TUI
    p = fresh(app, data);
  } catch (e) {
    return fail(app, e);
  }
  app.dispatch({
    type: "open",
    dialog: {
      kind: "select",
      purpose: { type: "profiles" },
      title: "Profiles",
      deletable: true,
      empty: "no profiles",
      options: p.names.map((n) => {
        const d = app.getState().drafts[n];
        const unsaved = d ? dirtyCount(d) : 0;
        return {
          value: n,
          title: n,
          current: n === p.here,
          detail: [
            n === p.active ? "active" : "",
            p.repo && n === p.here ? "this repo" : "",
            unsaved ? `${unsaved} unsaved` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        };
      }),
    },
  });
}

export const openNewProfile = (app: AppApi, from: string | null = null): void =>
  app.dispatch({
    type: "open",
    dialog: {
      kind: "prompt",
      purpose: from ? { type: "copy", from } : { type: "new" },
      title: from ? `Copy profile ${from}` : "New profile",
      label: "name: lowercase letters, digits and -, up to 32",
      value: "",
      error: null,
    },
  });

/** Opens the save dialog, or says there is nothing to save. */
export function openSave(app: AppApi): void {
  const d = currentDraft(app.getState());
  if (!d || dirtyCount(d) === 0) return app.toast({ variant: "info", message: "No unsaved changes" });
  app.dispatch({
    type: "open",
    dialog: { kind: "save", purpose: { type: "save", name: d.name }, error: null },
  });
}

export function openActivate(app: AppApi, data: Data): void {
  const d = currentDraft(app.getState());
  if (!d) return;
  let p: Data["profiles"]["value"];
  try {
    // a failed poll is read again here, so the prompt never names a stale active profile or binding
    p = data.profiles.error === null ? data.profiles.value : fresh(app, data);
  } catch (e) {
    return fail(app, e);
  }
  askActivate(app, d.name, p);
}

/**
 * The activate confirmation for `name`, worded for the scope `p` shows (its bound repo, or the global
 * profile), which the answer then applies; `notice` says why it asks again.
 */
function askActivate(app: AppApi, name: string, p: Data["profiles"]["value"], notice?: string): void {
  if (p?.here === name)
    return app.toast({
      variant: "info",
      message: p.repo ? `${name} is already this repo's profile` : `${name} is already active`,
    });
  const d = app.getState().drafts[name];
  const unsaved = d ? dirtyCount(d) : 0;
  app.dispatch({
    type: "open",
    dialog: {
      kind: "confirm",
      purpose: { type: "activate", name, repo: p?.repo ?? null },
      title: p?.repo ? `Use ${name} in this repo?` : `Make ${name} active?`,
      message: [
        ...(notice ? [notice] : []),
        p?.repo
          ? `Binds ${p.repo} to it; the active profile (${p.active}) and other repos keep theirs.`
          : "New Claude Code sessions and catherd's next dispatch use it; repos bound to another profile keep theirs.",
        ...(unsaved
          ? [`Its ${unsaved} unsaved change${unsaved === 1 ? " is" : "s are"} not part of it until you save.`]
          : []),
      ],
      yes: p?.repo ? "Bind to this repo" : "Make active",
      no: "Cancel",
      destructive: false,
    },
  });
}

export function openRevert(app: AppApi): void {
  const d = currentDraft(app.getState());
  if (!d || dirtyCount(d) === 0) return app.toast({ variant: "info", message: "No unsaved changes" });
  app.dispatch({
    type: "open",
    dialog: {
      kind: "confirm",
      purpose: { type: "revert", name: d.name },
      title: "Discard unsaved changes?",
      message: [
        `${plural(dirtyCount(d), "change")} to ${d.name} go back to what is saved. ctrl+x u undoes this.`,
      ],
      yes: "Discard",
      no: "Keep them",
      destructive: true,
    },
  });
}

/** Keeps a line for after exit, and says it now. */
function sessionsNeeded(app: AppApi, agents: string[]): void {
  if (agents.length === 0) return;
  app.keep([`catherd: start a new Claude Code session to use: ${agents.join(", ")}`]);
  app.toast({
    variant: "info",
    message: `New Claude Code session needed for ${plural(agents.length, "agent")}`,
  });
}

/**
 * Applies a confirmed activation to the scope the user was shown (`shown`: the bound repo, or null for the
 * global profile). The binding is read again first: when another process bound or unbound this repo while
 * the question was open, nothing is applied and the question comes back in the words for the scope now.
 */
function activateNow(app: AppApi, data: Data, name: string, shown: string | null): void {
  try {
    const now = app.effects.profiles();
    if (now.repo !== shown) {
      data.profiles.refresh();
      return askActivate(
        app,
        name,
        now,
        `Changed since this was first asked: ${now.repo ? `${now.repo} is now bound to ${now.here}` : `${shown} is no longer bound`}.`,
      );
    }
    const r = app.effects.activate(name, shown);
    data.profiles.refresh();
    app.toast({ variant: "success", message: shown ? `${name} is bound to ${shown}` : `${name} is active` });
    sessionsNeeded(app, r.newSessionNeededFor);
  } catch (e) {
    fail(app, e);
  }
}

/** The handlers of the profile dialogs that any tab can open; the App registers them once. */
export function useProfileDialogs(): void {
  const app = useApp();
  const data = useData();
  const nameError = (name: string): string | null => {
    if (!PROFILE_NAME.test(name))
      return "use lowercase letters, digits and -, up to 32, starting with a letter or digit";
    if ((data.profiles.value?.names ?? []).includes(name)) return `"${name}" already exists`;
    return null;
  };
  const create = (value: string, from?: string) => {
    const name = value.trim();
    const err = nameError(name);
    if (err) return app.dispatch({ type: "invalid", error: err });
    try {
      const r = app.effects.create(name, from);
      if (!r.saved)
        return app.dispatch({
          type: "invalid",
          error: r.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
        });
      data.profiles.refresh();
      app.dispatch({ type: "close" });
      showProfile(app, name);
      app.toast({ variant: "success", message: `Created profile ${name}` });
      sessionsNeeded(app, r.newSessionNeededFor);
    } catch (e) {
      app.dispatch({
        type: "invalid",
        error: isCatherdError(e) && e.fix ? `${e.message}. ${e.fix}` : message(e),
      });
    }
  };
  useDialogHandler("new", (_p, value) => create(value));
  useDialogHandler("copy", (p, value) => create(value, p.type === "copy" ? p.from : undefined));
  useDialogHandler("profiles", (_p, value) => {
    if (!value.startsWith("delete:")) {
      app.dispatch({ type: "close" });
      showProfile(app, value);
      return;
    }
    const name = value.slice("delete:".length);
    try {
      app.effects.remove(name);
      app.dispatch({ type: "forget", name });
      data.profiles.refresh();
      app.dispatch({ type: "close" });
      app.toast({ variant: "success", message: `Deleted profile ${name}` });
    } catch (e) {
      fail(app, e);
    }
  });
  useDialogHandler("activate", (p) => {
    app.dispatch({ type: "close" });
    if (p.type === "activate") activateNow(app, data, p.name, p.repo);
  });
  useDialogHandler("revert", (p) => {
    app.dispatch({ type: "close" });
    if (p.type !== "revert") return;
    const d = app.getState().drafts[p.name];
    let doc: ProfileDoc;
    try {
      // "what is saved" is the file now: another process may have saved it since the draft opened
      doc = app.effects.readProfile(p.name);
    } catch (e) {
      return fail(app, e);
    }
    app.dispatch({ type: "revert", name: p.name, doc });
    if (d && !isDeepStrictEqual(d.base, doc))
      app.toast({
        variant: "info",
        message: `${p.name} changed on disk: showing what is saved now`,
      });
  });
  useDialogHandler("save", async (p, value, extra) => {
    if (p.type !== "save") return;
    // the scope "Save & make active" was worded for as it was answered
    const shown = data.profiles.value?.repo ?? null;
    const d = app.getState().drafts[p.name];
    if (!d) return app.dispatch({ type: "close" });
    // a second enter while the first save is writing is not a second save
    if (isSaving(app.getState())) return;
    // while it writes the dialog stays open and takes no answer, and the TUI does not quit
    app.dispatch({ type: "saving", name: p.name, on: true });
    let r: Awaited<ReturnType<AppApi["effects"]["save"]>>;
    try {
      r = await app.effects.save(p.name, patchBetween(d.base, d.doc), d.treatLikes, extra.shown);
    } catch (e) {
      app.dispatch({ type: "saving", name: p.name, on: false });
      return app.dispatch({
        type: "invalid",
        error: isCatherdError(e) && e.fix ? `${e.message}. ${e.fix}` : message(e),
      });
    }
    app.dispatch({ type: "saving", name: p.name, on: false });
    // another process changed the profile while this one saved: nothing is written, and the dialog shows
    // what saving would do now and asks again
    if (!r.saved && r.errors.some((e) => e.path === CHANGED_ON_DISK) && extra.changed) {
      app.dispatch({ type: "invalid", error: null });
      return extra.changed();
    }
    if (!r.saved)
      return app.dispatch({
        type: "invalid",
        error: r.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      });
    // saved: this dialog closes (only if it is still the top one), so what fails from here on is a toast
    const top = app.getState().dialogs.at(-1);
    if (top?.kind === "save" && top.purpose.name === p.name) app.dispatch({ type: "close" });
    try {
      // the draft as the save began: an edit made since stays staged over what was saved
      const from = { doc: d.doc, treatLikes: d.treatLikes };
      app.dispatch({ type: "saved", name: p.name, doc: app.effects.readProfile(p.name), from });
    } catch (e) {
      fail(app, e);
    }
    app.toast({ variant: "success", message: `Saved profile ${p.name}` });
    sessionsNeeded(app, r.newSessionNeededFor);
    if (value === "activate") activateNow(app, data, p.name, shown);
  });
}
