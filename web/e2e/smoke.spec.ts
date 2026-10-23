import { readdirSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { appendEvent, consoleErrors, signIn, state } from "./helpers";

const pages = (): [string, string][] => [
  ["/", "Dashboard"],
  ["/runs", "Runs"],
  [`/runs/${state().a.id}`, "wallet split"],
  [`/runs/${state().fixture.id}`, "case helpers"],
  ["/questions", "Questions"],
  ["/setup", "Setup"],
];

test("the server's PATH holds bun and the system dirs only, so no backend CLI is found", () => {
  const dirs = state().path.split(":");
  expect(dirs.slice(1)).toEqual(["/usr/bin", "/bin"]);
  expect(readdirSync(dirs[0]!)).toEqual(["bun"]);
});

test("redirects to login and rejects a wrong token", async ({ page }) => {
  await page.goto("/runs");
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await page.getByLabel("Token").fill("nope");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Wrong token.")).toBeVisible();
});

test("the token in the link signs in and leaves the address bar", async ({ page }) => {
  await signIn(page);
  expect(page.url()).not.toContain("e2e-token");
});

test("every page renders after sign-in, deep links survive a reload", async ({ page }) => {
  await signIn(page);
  for (const [path, heading] of pages()) {
    await page.goto(path);
    // a run report may open with the same h1
    await expect(page.getByRole("heading", { level: 1, name: heading }).first()).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
});

test("no page logs a console error", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);
  for (const [path, heading] of pages()) {
    await page.goto(path);
    // a run report may open with the same h1
    await expect(page.getByRole("heading", { level: 1, name: heading }).first()).toBeVisible();
    // a run page lays its graph out after the model loads: wait for the drawn graph
    if (path.startsWith("/runs/")) await expect(page.getByRole("button", { name: /^Run\. Done/ })).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("a run's timeline shows its events, and a new one arrives live", async ({ page }) => {
  await signIn(page);
  const { a } = state();
  await page.goto(`/runs/${a.id}`);
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline.getByRole("listitem").first()).toBeVisible();
  // the socket's start is fixed once it is open: append after that
  await expect(page.locator('output[data-connected="true"]')).toBeVisible();
  appendEvent(a.events, { type: "report.posted", kind: "parked", unit: "M1.L2", text: "M1.L2 parked" });
  await expect(timeline.getByRole("listitem").first()).toContainText("report (parked) on M1.L2");
});

test("no remora or bifrost name reaches the UI", async ({ page }) => {
  await signIn(page);
  for (const [path] of pages()) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/remora|bifrost|cliproxy|maxim/i);
  }
});
