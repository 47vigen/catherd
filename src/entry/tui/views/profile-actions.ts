import { isCatherdError } from "../../../domain/errors.ts";
import { PROFILE_NAME, patchBetween } from "../../../domain/profile.ts";
import { type AppApi, useApp, useDialogHandler } from "../providers/app.tsx";
import { type Data, useData } from "../providers/data.tsx";
import { currentDraft, dirtyCount } from "../state.ts";

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const fail = (app: AppApi, e: unknown) =>
  app.toast({
    variant: "error",
    message: isCatherdError(e) && e.fix ? `${e.message}. ${e.fix}` : message(e),
  });

/** Shows a profile in the Profiles tab, starting its draft from disk unless one is staged. */
export function showProfile(app: AppApi, name: string): void {
  try {
    app.dispatch({ type: "show", name, doc: app.effects.readProfile(name) });
  } catch (e) {
    fail(app, e);
  }
}

/** The profile list (`<leader>l`): enter shows one, ctrl+d twice deletes one. */
export function openProfileList(app: AppApi, data: Data): void {
  const p = data.profiles.value ?? app.effects.profiles();
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
  const p = data.profiles.value;
  if (p?.here === d.name)
    return app.toast({
      variant: "info",
      message: p.repo ? `${d.name} is already this repo's profile` : `${d.name} is already active`,
    });
  const unsaved = dirtyCount(d);
  app.dispatch({
    type: "open",
    dialog: {
      kind: "confirm",
      purpose: { type: "activate", name: d.name },
      title: p?.repo ? `Use ${d.name} in this repo?` : `Make ${d.name} active?`,
      message: [
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
      message: [`${dirtyCount(d)} change(s) to ${d.name} go back to what is saved. ctrl+x u undoes this.`],
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
  app.toast({ variant: "info", message: `New Claude Code session needed for ${agents.length} agent(s)` });
}

function activateNow(app: AppApi, data: Data, name: string): void {
  try {
    const repo = data.profiles.value?.repo ?? null;
    const r = app.effects.activate(name);
    data.profiles.refresh();
    app.toast({ variant: "success", message: repo ? `${name} is bound to ${repo}` : `${name} is active` });
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
      return showProfile(app, value);
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
    if (p.type === "activate") activateNow(app, data, p.name);
  });
  useDialogHandler("revert", (p) => {
    app.dispatch({ type: "close" });
    if (p.type === "revert") app.dispatch({ type: "revert", name: p.name });
  });
  useDialogHandler("save", async (p, value) => {
    if (p.type !== "save") return;
    const d = app.getState().drafts[p.name];
    if (!d) return app.dispatch({ type: "close" });
    let r: Awaited<ReturnType<AppApi["effects"]["save"]>>;
    try {
      r = await app.effects.save(p.name, patchBetween(d.base, d.doc), d.treatLikes);
    } catch (e) {
      return app.dispatch({
        type: "invalid",
        error: isCatherdError(e) && e.fix ? `${e.message}. ${e.fix}` : message(e),
      });
    }
    if (!r.saved)
      return app.dispatch({
        type: "invalid",
        error: r.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      });
    // saved: the dialog closes, so what fails from here on is a toast
    app.dispatch({ type: "close" });
    try {
      app.dispatch({ type: "saved", name: p.name, doc: app.effects.readProfile(p.name) });
    } catch (e) {
      fail(app, e);
    }
    app.toast({ variant: "success", message: `Saved profile ${p.name}` });
    sessionsNeeded(app, r.newSessionNeededFor);
    if (value === "activate") activateNow(app, data, p.name);
  });
}
