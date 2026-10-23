import { existsSync, readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { consoleErrors, signIn, state } from "./helpers";

const idleMin = () => {
  const { profile } = state();
  if (!existsSync(profile)) return undefined;
  const doc = JSON.parse(readFileSync(profile, "utf8")) as {
    roles?: { worker?: { timeouts?: { idleMin?: number } } };
  };
  return doc.roles?.worker?.timeouts?.idleMin;
};

test("editing a role in its drawer shows before → after and saves to the profile", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);
  await page.goto("/setup");

  await page.getByRole("button", { name: "Edit worker" }).click();
  const drawer = page.getByRole("dialog", { name: "Worker" });
  await drawer.getByRole("textbox", { name: "Stop when silent for" }).fill("7");
  await drawer.getByRole("button", { name: "Review changes" }).click();

  const review = page.getByRole("dialog", { name: "Review changes" });
  const change = review.getByRole("listitem").filter({ hasText: "idleMin" });
  await expect(change).toContainText("Before");
  await expect(change).toContainText(/After\s*7/);
  expect(idleMin()).toBeUndefined();
  await review.getByRole("button", { name: "Save" }).click();
  await expect(review).toBeHidden();
  await expect.poll(idleMin).toBe(7);

  await page.reload();
  await expect(
    page.getByRole("dialog", { name: "Worker" }).getByRole("textbox", { name: "Stop when silent for" }),
  ).toHaveValue("7");
  expect(errors).toEqual([]);
});
