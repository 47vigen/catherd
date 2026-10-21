import { appendFileSync, readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

const state = () =>
  JSON.parse(readFileSync("test-results/e2e-state.json", "utf8")) as {
    a: { id: string; events: string };
    b: { id: string };
  };

/** Signs in through the link `catherd panel` prints, and waits for the runs. */
async function signIn(page: Page) {
  await page.goto("/login#token=e2e-token");
  await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
}

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
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page);
  const pages: [string, string][] = [
    ["/runs", "Runs"],
    [`/runs/${state().a.id}`, "wallet split"],
    ["/questions", "Questions"],
    ["/setup", "Setup"],
  ];
  for (const [path, heading] of pages) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Setup" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a run's timeline shows its events, and a new one arrives live", async ({ page }) => {
  await signIn(page);
  const { a } = state();
  await page.goto(`/runs/${a.id}`);
  const timeline = page.getByRole("list", { name: "Timeline" });
  await expect(timeline.getByRole("listitem").first()).toContainText("parked");
  // the socket's start is fixed once it is open: append after that
  await expect(page.locator('output[data-connected="true"]')).toBeVisible();
  const last = readFileSync(a.events, "utf8").trim().split("\n").length;
  appendFileSync(
    a.events,
    `${JSON.stringify({ v: 1, seq: last + 1, at: new Date().toISOString(), type: "report.posted", kind: "parked", unit: "M1.L2", text: "M1.L2 parked" })}\n`,
  );
  await expect(timeline.getByRole("listitem").first()).toContainText("report (parked) on M1.L2");
});

test("answering a parked question clears it and records the answer", async ({ page }) => {
  await signIn(page);
  await page.goto("/questions");
  await page.getByRole("textbox", { name: "Your answer" }).fill("keep it");
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByText("Nothing is waiting for you.")).toBeVisible();
  const lines = readFileSync(state().a.events, "utf8").trim().split("\n");
  expect(JSON.parse(lines.at(-1)!).type).toBe("question.answered");
});

test("setup lists the backends and saves a role's rungs through the profile", async ({ page }) => {
  await signIn(page);
  await page.goto("/setup");
  await expect(page.getByRole("row", { name: /codex/ })).toContainText(/missing/i);
  const worker = page.getByRole("group", { name: "worker" });
  await worker.getByRole("button", { name: "Edit rungs" }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("option", { name: /codex:gpt-6-luna#high/ }).click();
  await drawer.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Saved\. worker climbs/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("group", { name: "worker" })).not.toContainText("codex:gpt-6-luna#high");
});

test("no remora or bifrost name reaches the UI", async ({ page }) => {
  await signIn(page);
  for (const path of ["/runs", `/runs/${state().a.id}`, "/questions", "/setup"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/remora|bifrost|cliproxy|maxim/i);
  }
});
