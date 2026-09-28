import type { ProfilePatch } from "../../domain/profile.ts";
import type { CommandId } from "./commands.ts";
import type { FixtureOptions } from "./fixtures.ts";
import type { AppApi } from "./providers/app.tsx";
import type { AppKeymap } from "./providers/keymap.tsx";
import type { Action } from "./state.ts";

/** One step towards a screen: a command as a key would run it, a reducer action, or a profile shown. */
export type Step = { command: CommandId } | { action: Action } | { show: string } | { edit: ProfilePatch };

export interface Story {
  name: string;
  title: string;
  steps: Step[];
  /** the fixtures the frame snapshots render it on (the storybook shows it on its one set) */
  fixtures?: FixtureOptions;
}

const SHOWN: Step[] = [{ show: "default" }];
const DIRTY: Step[] = [
  ...SHOWN,
  { edit: { budget: { usd: 5 }, roles: { verifier: { access: "read-only" } } } },
];

/**
 * Every view and widget in a state worth seeing (spec §9.4 `CATHERD_STORY=1`): the storybook lists them
 * and the frame snapshots render them at three sizes, in Unicode and plain.
 */
export const STORIES: Story[] = [
  {
    name: "status",
    title: "Status: checks with fixes, profile, recent runs",
    steps: [{ command: "tab.status" }],
  },
  { name: "profiles", title: "Profiles: the tree", steps: SHOWN },
  { name: "profiles-dirty", title: "Profiles: two unsaved changes", steps: DIRTY },
  {
    name: "save",
    title: "Save dialog: diff, agents, what applies when",
    steps: [...DIRTY, { command: "profile.save" }],
  },
  { name: "quit", title: "Quit with unsaved changes", steps: [...DIRTY, { command: "app.quit" }] },
  { name: "new-profile", title: "New profile prompt", steps: [{ command: "profile.new" }] },
  { name: "profile-list", title: "Profile list", steps: [{ command: "profile.list" }] },
  {
    name: "palette",
    title: "Command palette",
    steps: [{ command: "tab.status" }, { command: "app.palette" }],
  },
  { name: "help", title: "Keyboard shortcuts", steps: [{ command: "tab.status" }, { command: "app.help" }] },
  {
    name: "runs-empty",
    title: "Runs: no runs yet",
    steps: [{ command: "tab.runs" }],
    fixtures: { runs: [], sessions: [] },
  },
  { name: "runs", title: "Runs: the sessions", steps: [{ command: "tab.runs" }] },
  {
    name: "session",
    title: "Runs: one session with two runs, one continued elsewhere",
    steps: [{ command: "tab.runs" }, { action: { type: "session", key: "s-auth" } }],
  },
  {
    name: "session-live",
    title: "Runs: a live session with three live roles",
    steps: [{ command: "tab.runs" }, { action: { type: "session", key: "s-jobs" } }],
  },
  {
    name: "role",
    title: "Runs: a role opened",
    steps: [
      { command: "tab.runs" },
      { action: { type: "session", key: "s-jobs" } },
      { action: { type: "role", run: "20260926-114800-jobs-screen", dispatchId: "d1" } },
    ],
  },
  {
    name: "milestone",
    title: "Runs: a milestone opened on its digest",
    steps: [
      { command: "tab.runs" },
      { action: { type: "session", key: "s-jobs" } },
      { action: { type: "milestone", run: "20260926-114800-jobs-screen", name: "M0" } },
    ],
  },
];

/** One step, as a key or the reducer would take it. */
export function applyStep(s: Step, app: AppApi, keymap: AppKeymap): void {
  if ("command" in s) keymap.dispatchCommand(s.command);
  else if ("action" in s) app.dispatch(s.action);
  else if ("show" in s) app.dispatch({ type: "show", name: s.show, doc: app.effects.readProfile(s.show) });
  else app.dispatch({ type: "edit", patch: s.edit });
}

/** Plays a story's steps, letting the app draw between them (a step may need the view the last one opened). */
export async function playStory(
  story: Story,
  app: AppApi,
  keymap: AppKeymap,
  wait: () => Promise<void>,
): Promise<void> {
  for (const s of story.steps) {
    applyStep(s, app, keymap);
    await wait();
  }
}
