import { expect, test } from "@playwright/test";

import { consoleErrors, signIn, state, tile } from "./helpers";

test("the dashboard shows the live run, the waiting question and the KPIs, and opens the run", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);

  const stats = page.locator("dl").first();
  for (const label of ["Runs", "Finished alone", "Median time", "Interventions", "Cost", "Tokens"])
    await expect(stats.getByText(label, { exact: true })).toBeVisible();

  const running = tile(page, "Running now");
  await expect(running.getByRole("link", { name: "live split" })).toBeVisible();
  await expect(running).toContainText("M1.L1 worker");

  const waiting = tile(page, "Waiting for you");
  await expect(waiting).toContainText("Merge the split ids?");
  await expect(waiting).toContainText("Keep the old wallet id?");

  await running.getByRole("link", { name: "live split" }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${state().live.id}$`));
  await expect(page.getByRole("heading", { level: 1, name: "live split" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^M1\.L1 worker\. Running/ })).toBeVisible();
  expect(errors).toEqual([]);
});
