import { appendFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { appendEvent, consoleErrors, signIn, state } from "./helpers";

test("the flow advances live", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);
  const { live } = state();
  await page.goto(`/runs/${live.id}`);
  const lane = page.getByRole("button", { name: /^T1 worker · / });
  await expect(lane).toHaveAccessibleName(/^T1 worker · running/);
  // the socket's start is fixed once it is open: append after that
  await expect(page.locator('output[data-connected="true"]')).toBeVisible();

  // the running worker's log tails its stream
  await lane.click();
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("tab", { name: "Log" }).click();
  const log = drawer.getByRole("region", { name: "Log" });
  const cards = log.locator("li[data-kind]");
  await expect(cards.first()).toBeVisible();
  const before = await cards.count();
  appendFileSync(
    live.stream,
    `${JSON.stringify({ type: "item.completed", item: { id: "item_99", type: "agent_message", text: "The split is written." } })}\n`,
  );
  await expect(log).toContainText("The split is written.");
  expect(await cards.count()).toBeGreaterThan(before);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  await appendEvent(live.events, {
    type: "dispatch.ended",
    dispatchId: "D0101",
    name: "T1",
    unit: "T1",
    status: "ok",
    replyStatus: "complete",
    reason: null,
    why: "the split is written",
    thread: null,
    head: null,
    environment: null,
    verdict: null,
    findings: [],
    replyPath: "roles/T1/D0101/reply.md",
  });
  await expect(lane).toHaveAccessibleName(/^T1 worker · complete/);
  expect(errors).toEqual([]);
});

test("the fixture run's drawer shows prompt and output (an earlier build's run, spec D16)", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);
  await page.goto(`/runs/${state().fixture.id}`);
  const drawer = page.getByRole("dialog");

  await page.getByRole("button", { name: /^M1\.L1 worker\. Done/ }).click();
  await drawer.getByRole("tab", { name: "Prompt" }).click();
  const outline = drawer.getByRole("navigation", { name: "Prompt sections" });
  await expect(outline.getByRole("button", { name: /^Role, \d+ words$/ })).toBeVisible();
  await expect(outline.getByRole("button", { name: /^Context, \d+ words$/ })).toBeVisible();
  await drawer.getByRole("tab", { name: "Output" }).click();
  await expect(drawer).toContainText("STATUS: complete");
  expect(errors).toEqual([]);
});
