import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { defineCommand } from "citty";
import { createElement, type ReactNode } from "react";
import { Dashboard } from "./dashboard.tsx";
import { Init } from "./init.tsx";
import { detectUi } from "./theme.ts";

const uiArgs = {
  plain: { type: "boolean", description: "ASCII only: a text fallback for every glyph" },
  "reduced-motion": { type: "boolean", description: "No animation" },
} as const;

export const isBare = (rawArgs: string[]): boolean => rawArgs.every((a) => a.startsWith("-"));

export async function mount(el: ReactNode, stdin: { isTTY?: boolean } = process.stdin): Promise<number> {
  if (!stdin.isTTY) {
    console.error(
      "catherd: this screen needs an interactive terminal. Scripts can use the MCP tools (status, profile_get).",
    );
    return 1;
  }
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  createRoot(renderer).render(el);
  await new Promise<void>((resolve) => renderer.once("destroy", () => resolve()));
  return Number(process.exitCode ?? 0);
}

/** The main command's run. citty runs it after any subcommand too, hence the isBare check.
 * Bare `catherd` opens the dashboard; Profile/Watch/Setup from there render Editor/Watch/Init
 * inline, in the same mounted tree — see dashboard.tsx. */
export async function editorRun({ rawArgs }: { rawArgs: string[] }): Promise<void> {
  if (!isBare(rawArgs)) return;
  process.exitCode = await mount(createElement(Dashboard, { ui: detectUi(rawArgs) }));
}

export const initCommand = defineCommand({
  meta: { name: "init", description: "First run: the Jev key, your backends, and a profile" },
  args: uiArgs,
  async run({ rawArgs }) {
    const code = await mount(createElement(Init, { ui: detectUi(rawArgs) }));
    process.exitCode = process.exitCode || code;
  },
});
