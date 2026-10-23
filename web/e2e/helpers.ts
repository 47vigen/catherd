import { appendFileSync, readFileSync } from "node:fs";

import { expect, type Page } from "@playwright/test";

/** Where test/panel-e2e-serve.ts seeded its runs and the profile file. */
export interface E2eState {
  home: string;
  a: { id: string; events: string };
  b: { id: string };
  fixture: { id: string };
  live: { id: string; events: string; stream: string };
  profile: string;
  /** the server's PATH */
  path: string;
}

export const state = () => JSON.parse(readFileSync("test-results/e2e-state.json", "utf8")) as E2eState;

/** Signs in through the link `catherd panel` prints, and waits for the dashboard. */
export async function signIn(page: Page) {
  await page.goto("/login#token=e2e-token");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
}

/** Every console error and uncaught page error from now on; a test asserts it stays empty. */
export function consoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${m.text()} (${m.location().url})`);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** Appends one event to a run, numbered after the last one, as the run store would. */
export function appendEvent(events: string, e: Record<string, unknown>) {
  const seq = readFileSync(events, "utf8").trim().split("\n").length + 1;
  appendFileSync(events, `${JSON.stringify({ v: 1, seq, at: new Date().toISOString(), ...e })}\n`);
}

/** A bento tile, found by its title. */
export const tile = (page: Page, title: string) =>
  page
    .locator("header")
    .filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) })
    .locator("..");
