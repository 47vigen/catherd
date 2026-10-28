import { readFileSync } from "node:fs";

import { expect, type Page } from "@playwright/test";

/** Where test/panel-e2e-serve.ts seeded its runs and the profile file. */
export interface E2eState {
  home: string;
  /** `events` is the URL appendEvent and lastEvent talk to, not a file */
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

/** Appends one event to a run through the real run store (`events` is the URL the e2e server gave the run). */
export async function appendEvent(events: string, e: Record<string, unknown>) {
  const res = await fetch(events, { method: "POST", body: JSON.stringify(e) });
  if (!res.ok) throw new Error(`appending ${String(e.type)} failed: ${await res.text()}`);
}

/** The last event of a run, read through the same endpoint. */
export const lastEvent = async (events: string) =>
  (await (await fetch(events)).json()) as { type: string; unit?: string };

/** A bento tile, found by its title. */
export const tile = (page: Page, title: string) =>
  page
    .locator("header")
    .filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) })
    .locator("..");
