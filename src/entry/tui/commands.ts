// Command ids and default keys follow anomalyco/opencode packages/tui/src/config/keybind.ts
// (MIT, © 2025 opencode); see THIRD_PARTY_NOTICES.md.
import { z } from "zod";
import { CatherdError } from "../../domain/errors.ts";

/**
 * Where a command's keys are live (spec §9.2's context stack global → tab → pane → dialog → input).
 * - `global`: in every mode, dialogs included.
 * - `app`, `tab.*`, `list`: the base mode (no dialog open); their printable keys only while no text input
 *   has focus.
 * - `row.*`: the base mode, and only while no text input has focus (their keys act on the selected row).
 * - `filter`: only while a list's filter input has focus.
 * - `dialog`: only while a dialog is open (the keymap's modal mode).
 */
export const SCOPES = [
  "global",
  "app",
  "tab.status",
  "tab.profiles",
  "tab.runs",
  "list",
  "row.status",
  "row.profiles",
  "row.runs",
  "filter",
  "dialog",
] as const;
export type Scope = (typeof SCOPES)[number];

export type Group = "App" | "Tabs" | "Profiles" | "Edit" | "Status" | "Runs" | "Lists" | "Dialogs";

export interface CommandDef {
  id: string;
  title: string;
  group: Group;
  scope: Scope;
  /** default keys, in the keymap's syntax: `ctrl+s`, `shift+g`, `<leader>n`, `space`, `return` */
  keys: readonly string[];
  /** listed in the command palette */
  palette?: true;
  /** listed under "Suggested" while the palette's filter is empty */
  suggested?: true;
  /** footer order; commands without one are never hinted */
  hint?: number;
  /** the footer's label, when the title is too long for it */
  short?: string;
  /** the CLI command that does the same, shown in the palette (research C3: the TUI teaches the CLI) */
  cli?: string;
}

/** The leader key and its timeout (spec §9.2: `ctrl+x`, 2 s, as in opencode). */
export const LEADER = "ctrl+x";
export const LEADER_TIMEOUT_MS = 2_000;

/** Every action in the TUI. The palette, footer, help and keys all come from this one table. */
export const COMMANDS = [
  // global: live in every mode
  { id: "app.interrupt", title: "Cancel, or quit", group: "App", scope: "global", keys: ["ctrl+c"] },
  { id: "app.back", title: "Back", group: "App", scope: "global", keys: ["escape"] },

  // app: any tab, no dialog open
  {
    id: "app.palette",
    title: "Command palette",
    group: "App",
    scope: "app",
    keys: ["ctrl+p", ":"],
    hint: 90,
    short: "commands",
  },
  {
    id: "app.help",
    title: "Keyboard shortcuts",
    group: "App",
    scope: "app",
    keys: ["?"],
    palette: true,
    hint: 91,
    short: "help",
  },
  { id: "app.quit", title: "Quit", group: "App", scope: "app", keys: ["q", "<leader>q"], palette: true },
  {
    id: "app.stories",
    title: "Stories…",
    group: "App",
    scope: "app",
    keys: [],
    palette: true,
    suggested: true,
  },
  {
    id: "tab.status",
    title: "Go to Status",
    group: "Tabs",
    scope: "app",
    keys: ["1", "<leader>1"],
    palette: true,
  },
  {
    id: "tab.profiles",
    title: "Go to Profiles",
    group: "Tabs",
    scope: "app",
    keys: ["2", "<leader>2"],
    palette: true,
  },
  {
    id: "tab.runs",
    title: "Go to Runs",
    group: "Tabs",
    scope: "app",
    keys: ["3", "<leader>3"],
    palette: true,
  },
  { id: "tab.next", title: "Next tab", group: "Tabs", scope: "app", keys: ["]"] },
  { id: "tab.prev", title: "Previous tab", group: "Tabs", scope: "app", keys: ["["] },
  {
    id: "profile.new",
    title: "New profile…",
    group: "Profiles",
    scope: "app",
    keys: ["<leader>n"],
    palette: true,
    suggested: true,
    cli: "catherd profile new <name>",
  },
  {
    id: "profile.list",
    title: "Switch profile…",
    group: "Profiles",
    scope: "app",
    keys: ["<leader>l"],
    palette: true,
    suggested: true,
    cli: "catherd profile list",
  },

  // tab.status
  {
    id: "status.recheck",
    title: "Re-check setup",
    group: "Status",
    scope: "tab.status",
    keys: ["r"],
    palette: true,
    suggested: true,
    hint: 3,
    short: "re-check",
    cli: "catherd doctor",
  },
  {
    id: "status.copy",
    title: "Copy the fix command",
    group: "Status",
    scope: "tab.status",
    keys: ["y"],
    palette: true,
    hint: 2,
    short: "copy fix",
  },

  // tab.profiles
  {
    id: "profile.save",
    title: "Save profile…",
    group: "Profiles",
    scope: "tab.profiles",
    keys: ["ctrl+s"],
    palette: true,
    suggested: true,
    hint: 3,
    short: "save",
    cli: "catherd profile set <path> <value>",
  },
  {
    id: "profile.activate",
    title: "Make this profile active…",
    group: "Profiles",
    scope: "tab.profiles",
    keys: ["a"],
    palette: true,
    hint: 6,
    short: "activate",
    cli: "catherd profile use <name>",
  },
  {
    id: "profile.copy",
    title: "Copy this profile…",
    group: "Profiles",
    scope: "tab.profiles",
    keys: [],
    palette: true,
    cli: "catherd profile copy <from> <name>",
  },
  {
    id: "profile.revert",
    title: "Discard unsaved changes…",
    group: "Profiles",
    scope: "tab.profiles",
    keys: [],
    palette: true,
  },
  {
    id: "catalog.refresh",
    title: "Refresh the model catalog",
    group: "Profiles",
    scope: "tab.profiles",
    keys: ["r"],
    palette: true,
    cli: "catherd catalog refresh",
  },
  {
    id: "edit.undo",
    title: "Undo",
    group: "Edit",
    scope: "tab.profiles",
    keys: ["<leader>u"],
    palette: true,
    hint: 7,
    short: "undo",
  },
  {
    id: "edit.redo",
    title: "Redo",
    group: "Edit",
    scope: "tab.profiles",
    keys: ["<leader>r"],
    palette: true,
  },

  // tab.runs
  {
    id: "runs.refresh",
    title: "Refresh now",
    group: "Runs",
    scope: "tab.runs",
    keys: ["r"],
    palette: true,
    hint: 3,
    short: "refresh",
  },
  {
    id: "runs.pause",
    title: "Pause or resume updates",
    group: "Runs",
    scope: "tab.runs",
    keys: ["p"],
    palette: true,
    hint: 4,
    short: "pause",
  },

  // list: every list and tree
  { id: "list.up", title: "Move up", group: "Lists", scope: "list", keys: ["up", "k"] },
  { id: "list.down", title: "Move down", group: "Lists", scope: "list", keys: ["down", "j"] },
  { id: "list.pageUp", title: "Page up", group: "Lists", scope: "list", keys: ["pageup"] },
  { id: "list.pageDown", title: "Page down", group: "Lists", scope: "list", keys: ["pagedown"] },
  { id: "list.first", title: "First row", group: "Lists", scope: "list", keys: ["home", "g"] },
  { id: "list.last", title: "Last row", group: "Lists", scope: "list", keys: ["end", "shift+g"] },
  {
    id: "list.filter",
    title: "Filter",
    group: "Lists",
    scope: "list",
    keys: ["/"],
    hint: 8,
    short: "filter",
  },

  // row.*: act on the selected row
  {
    id: "status.open",
    title: "Open",
    group: "Status",
    scope: "row.status",
    keys: ["return"],
    hint: 1,
    short: "open",
  },
  {
    id: "tree.toggle",
    title: "Toggle",
    group: "Profiles",
    scope: "row.profiles",
    keys: ["space"],
    hint: 1,
    short: "toggle",
  },
  {
    id: "tree.open",
    title: "Change or expand",
    group: "Profiles",
    scope: "row.profiles",
    keys: ["return"],
    hint: 2,
    short: "change",
  },
  { id: "tree.expand", title: "Expand", group: "Profiles", scope: "row.profiles", keys: ["right", "l"] },
  {
    id: "tree.collapse",
    title: "Collapse, or go to the parent",
    group: "Profiles",
    scope: "row.profiles",
    keys: ["left", "h"],
  },
  {
    id: "runs.open",
    title: "Open the run",
    group: "Runs",
    scope: "row.runs",
    keys: ["return"],
    hint: 1,
    short: "open",
  },
  {
    id: "runs.cancel",
    title: "Cancel the selected role (press twice)",
    group: "Runs",
    scope: "row.runs",
    keys: ["ctrl+d"],
    hint: 2,
    short: "cancel",
    cli: "catherd runs cancel <run> <name>",
  },

  // filter: a list's filter input has focus
  {
    id: "filter.accept",
    title: "Keep the filter",
    group: "Lists",
    scope: "filter",
    keys: ["return"],
    hint: 1,
    short: "done",
  },

  // dialog: a dialog is open
  { id: "dialog.up", title: "Previous", group: "Dialogs", scope: "dialog", keys: ["up", "ctrl+p"] },
  { id: "dialog.down", title: "Next", group: "Dialogs", scope: "dialog", keys: ["down", "ctrl+n"] },
  { id: "dialog.pageUp", title: "Page up", group: "Dialogs", scope: "dialog", keys: ["pageup"] },
  { id: "dialog.pageDown", title: "Page down", group: "Dialogs", scope: "dialog", keys: ["pagedown"] },
  {
    id: "dialog.left",
    title: "Previous button",
    group: "Dialogs",
    scope: "dialog",
    keys: ["left", "shift+tab"],
  },
  { id: "dialog.right", title: "Next button", group: "Dialogs", scope: "dialog", keys: ["right", "tab"] },
  {
    id: "dialog.submit",
    title: "Choose",
    group: "Dialogs",
    scope: "dialog",
    keys: ["return"],
    hint: 1,
    short: "choose",
  },
  {
    id: "dialog.delete",
    title: "Delete (press twice)",
    group: "Dialogs",
    scope: "dialog",
    keys: ["ctrl+d"],
    hint: 2,
    short: "delete",
  },
] as const satisfies readonly CommandDef[];

export type CommandId = (typeof COMMANDS)[number]["id"];
export type Keybinds = Record<CommandId, readonly string[]>;

const BY_ID = new Map<string, CommandDef>(COMMANDS.map((c) => [c.id, c]));
export const commandDef = (id: CommandId): CommandDef => BY_ID.get(id) as CommandDef;
export const commandsIn = (scope: Scope): CommandDef[] => COMMANDS.filter((c) => c.scope === scope);

/** Keys a text input would take as typing: one character, `space`, or a shifted letter. */
export const isPrintable = (key: string): boolean =>
  [...key].length === 1 || key === "space" || /^shift\+.$/.test(key);

/** Scopes whose printable keys go quiet while a text input has focus. */
const GUARDED: readonly Scope[] = ["app", "tab.status", "tab.profiles", "tab.runs", "list"];
export const isGuarded = (scope: Scope): boolean => GUARDED.includes(scope);

/** Commands only the ctrl+c layering may run; rebinding them could leave no way out. */
export const RESERVED: readonly CommandId[] = ["app.interrupt", "app.back"];

export const DEFAULT_KEYS: Keybinds = Object.fromEntries(
  COMMANDS.map((c): [string, readonly string[]] => [c.id, c.keys]),
) as Keybinds;

/** Spec §9.2 `config.json` `keybinds`: `{ <command id>: string | string[] | "none" }`. */
export const KeybindsSchema = z.record(z.string(), z.union([z.string().min(1), z.array(z.string().min(1))]));

/** The stacks of scopes that can be live at once; a key must mean one thing in each. */
export const CONTEXTS: readonly { tab: "status" | "profiles" | "runs" | null; typing: boolean }[] = [
  ...(["status", "profiles", "runs"] as const).flatMap((tab) => [
    { tab, typing: false },
    { tab, typing: true },
  ]),
  { tab: null, typing: true },
];

/** The keys live in one context, with the command each would run. */
export function keysIn(ctx: (typeof CONTEXTS)[number], keys: Keybinds): [string, CommandId][] {
  const scopes: Scope[] =
    ctx.tab === null
      ? ["global", "dialog"]
      : ["global", "app", `tab.${ctx.tab}`, "list", ctx.typing ? "filter" : `row.${ctx.tab}`];
  const out: [string, CommandId][] = [];
  for (const c of COMMANDS) {
    if (!scopes.includes(c.scope)) continue;
    for (const k of keys[c.id])
      if (!(ctx.typing && isGuarded(c.scope) && isPrintable(k))) out.push([k, c.id]);
  }
  return out;
}

/** Every key that means two things somewhere: `"<key>: <id>, <id> (<context>)"`. */
export function duplicateKeys(keys: Keybinds): string[] {
  const out: string[] = [];
  for (const ctx of CONTEXTS) {
    const seen = new Map<string, CommandId>();
    for (const [k, id] of keysIn(ctx, keys)) {
      const first = seen.get(k);
      if (first && first !== id)
        out.push(`${k}: ${first}, ${id} (${ctx.tab ?? "dialog"}${ctx.typing && ctx.tab ? ", typing" : ""})`);
      else seen.set(k, id);
    }
  }
  return [...new Set(out)];
}

/**
 * The keys in force: the defaults with `config.json`'s `keybinds` over them. Unknown ids, reserved
 * commands and overrides that make one key mean two things are refused with `E_CONFIG_KEYBIND`.
 */
export function resolveKeybinds(raw: unknown): Keybinds {
  const keys: Keybinds = { ...DEFAULT_KEYS };
  if (raw === undefined) return keys;
  const parsed = KeybindsSchema.safeParse(raw);
  if (!parsed.success)
    throw new CatherdError("E_CONFIG_KEYBIND", "config.json keybinds must map command ids to keys", {
      fix: 'e.g. "keybinds": { "profile.save": "ctrl+w", "app.help": "none" }',
    });
  for (const [id, value] of Object.entries(parsed.data)) {
    if (!BY_ID.has(id))
      throw new CatherdError("E_CONFIG_KEYBIND", `config.json keybinds: no command "${id}"`, {
        fix: "the command palette (ctrl+p) and catherd's README list the command ids",
      });
    if ((RESERVED as readonly string[]).includes(id))
      throw new CatherdError("E_CONFIG_KEYBIND", `config.json keybinds: "${id}" cannot be rebound`, {
        fix: `remove "${id}" from keybinds`,
      });
    // a comma list is several keys, as in opencode's config
    const list = (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(",").map((k) => k.trim()));
    keys[id as CommandId] = list.includes("none") ? [] : list.filter(Boolean);
  }
  const dup = duplicateKeys(keys);
  if (dup.length)
    throw new CatherdError(
      "E_CONFIG_KEYBIND",
      `config.json keybinds give one key two meanings: ${dup.join("; ")}`,
      {
        fix: 'bind one of them to another key, or to "none"',
      },
    );
  return keys;
}

const WORDS: Record<string, string> = {
  return: "enter",
  escape: "esc",
  pageup: "pgup",
  pagedown: "pgdn",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};
const PLAIN_WORDS: Record<string, string> = { up: "up", down: "down", left: "left", right: "right" };

/** How a key reads in the footer, palette and help: `ctrl+x n`, `enter`, `G`, `↑`. */
export function formatKey(key: string, plain = false): string {
  if (key.startsWith("<leader>")) return `${LEADER} ${formatKey(key.slice("<leader>".length), plain)}`;
  if (/^shift\+[a-z]$/.test(key)) return key.slice(-1).toUpperCase();
  return (plain ? PLAIN_WORDS[key] : undefined) ?? WORDS[key] ?? key;
}

/** All of a command's keys, `/`-joined, or "" when it has none. */
export const formatKeys = (keys: readonly string[], plain = false): string =>
  keys.map((k) => formatKey(k, plain)).join("/");
