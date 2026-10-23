import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { consoleErrors, signIn, state, tile } from "./helpers";

const lastEvent = (events: string) =>
  JSON.parse(readFileSync(events, "utf8").trim().split("\n").at(-1)!) as { type: string; unit?: string };

test("a question answered from the graph node clears it", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);
  const { live } = state();
  await page.goto(`/runs/${live.id}`);
  await page.getByRole("button", { name: /^M1\.L2 worker\. Waiting for you/ }).click();
  const question = page.getByRole("dialog").getByRole("region", { name: "Question" });
  await expect(question).toContainText("Merge the split ids?");
  await question.getByRole("textbox", { name: "Your answer" }).fill("merge them");
  await question.getByRole("button", { name: "Send answer" }).click();
  await expect(question).toBeHidden();
  expect(lastEvent(live.events)).toMatchObject({ type: "question.answered", unit: "M1.L2" });
  expect(errors).toEqual([]);
});

test("one answered from Questions moves to Recently answered", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);
  await page.goto("/questions");
  await expect(page.getByText("Keep the old wallet id?")).toBeVisible();
  await page.getByRole("textbox", { name: "Your answer" }).fill("keep it");
  await page.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByText("Nothing is waiting for you.")).toBeVisible();
  await expect(tile(page, "Recently answered")).toContainText("keep it");
  expect(lastEvent(state().a.events).type).toBe("question.answered");
  expect(errors).toEqual([]);
});
