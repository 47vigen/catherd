import type { RunNode } from "../../../../client";

export const TABS = ["overview", "decision", "prompt", "log", "output", "changes", "checks"] as const;
export type Tab = (typeof TABS)[number];

export const TAB_LABEL: Record<Tab, string> = {
  overview: "Overview",
  decision: "Decision",
  prompt: "Prompt",
  log: "Log",
  output: "Output",
  changes: "Changes",
  checks: "Checks",
};

/** The tabs that mean something for a step: a role has a decision, a prompt, a log and an output; a check has its logs. */
export function tabsFor(n: RunNode): Tab[] {
  const tabs: Tab[] = ["overview"];
  if (n.role) tabs.push("decision", "prompt", "log", "output");
  if (n.kind === "lane" || n.kind === "commit" || n.kind === "land") tabs.push("changes");
  if (n.kind === "check") tabs.push("checks");
  return tabs;
}

export const parseTab = (v: unknown): Tab | undefined => TABS.find((t) => t === v);
