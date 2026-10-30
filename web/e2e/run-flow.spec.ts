import { expect, test } from "@playwright/test";

import { appendEvent, consoleErrors, signIn, state } from "./helpers";

for (const colorScheme of ["light", "dark"] as const) {
  test(`completed architect flow in ${colorScheme} mode`, async ({ page }, testInfo) => {
    const errors = consoleErrors(page);
    await signIn(page);
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("menuitemradio", { name: colorScheme === "light" ? "Light" : "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    await page.goto(`/runs/${state().flow.id}`);
    const flow = page.getByRole("region", { name: "Run flow" });
    await expect(flow).toBeVisible();
    await expect(page.locator("svg[aria-label='Run graph']")).toHaveCount(0);
    const labels = flow.locator('svg[aria-label="Flow rows"] span').filter({ hasText: /^L[1-8]$/ });
    await expect(labels).toHaveText(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"]);
    const timeline = flow.getByRole("region", { name: "Flow timeline" });
    await expect(timeline.locator("text").filter({ hasText: /^Gap$/ }).first()).toBeAttached();
    await expect(timeline.getByRole("button", { name: /^T1 worker · limit/ })).toHaveAttribute("data-tone", "warning");
    await expect(timeline.getByRole("button", { name: /^T4 reviewer · cancelled/ })).toHaveAttribute(
      "data-tone",
      "danger",
    );
    await expect(timeline.getByRole("button", { name: /^C1 check/ })).toHaveAttribute("data-tone", "danger");
    await expect(timeline.getByRole("button", { name: /^T7 worker/ })).toHaveAccessibleName(/Rung changed/);
    await flow.getByRole("button", { name: /T1.*worker/i }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toContainText(/T1/);
    await page.keyboard.press("Escape");
    await flow.getByRole("button", { name: /C1/ }).click();
    await expect(drawer).toContainText("new failure");
    await expect(drawer).toContainText("inherited failure");
    await page.keyboard.press("Escape");
    await flow.getByRole("button", { name: /architect-1/i }).click();
    await expect(drawer).toContainText("Plan the flow tasks");
    await page.keyboard.press("Escape");
    const screenshot = `test-results/flow-${colorScheme}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`flow-${colorScheme}`, { path: screenshot, contentType: "image/png" });
    expect(errors).toEqual([]);
  });
}

test("flow scrolls inside its card on a phone", async ({ page }, testInfo) => {
  const errors = consoleErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto(`/runs/${state().flow.id}`);
  const flow = page.getByRole("region", { name: "Run flow" });
  const track = page.getByRole("region", { name: "Flow timeline" });
  const label = flow.getByText("L1", { exact: true });
  await expect(label).toBeVisible();
  const before = await label.boundingBox();
  const dimensions = await track.evaluate((el) => {
    const result = { scroll: el.scrollWidth, client: el.clientWidth };
    el.scrollLeft = el.scrollWidth;
    return result;
  });
  expect(dimensions.scroll).toBeGreaterThan(dimensions.client);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect((await label.boundingBox())?.x).toBeCloseTo(before?.x ?? -1, 0);
  const screenshot = "test-results/flow-phone.png";
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach("flow-phone", { path: screenshot, contentType: "image/png" });
  expect(errors).toEqual([]);
});

test("the live flow updates from socket events", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);
  const { flowLive: live } = state();
  await page.goto(`/runs/${live.id}`);
  await expect(page.locator('output[data-connected="true"]')).toBeVisible();
  const flow = page.getByRole("region", { name: "Run flow" });
  const worker = flow.getByRole("button", { name: /T1.*worker/i });
  await expect(worker).toHaveAccessibleName(/^T1 worker · running/);
  await appendEvent(live.events, {
    type: "check.requested",
    checkId: "C-live",
    command: "bun test",
    scope: "full",
    base: false,
    fresh: true,
    by: "architect-1",
    why: "Check live changes",
  });
  const check = flow.getByRole("button", { name: /C-live/ });
  await expect(check).toBeVisible();
  await appendEvent(live.events, {
    type: "dispatch.ended",
    dispatchId: "D0201",
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
  await expect(worker).toHaveAccessibleName(/^T1 worker · complete/);
  await expect(
    flow
      .getByRole("region", { name: "Flow timeline" })
      .locator("text")
      .filter({ hasText: /^Check$/ })
      .first(),
  ).toBeAttached();
  await appendEvent(live.events, {
    type: "check.done",
    checkId: "C-live",
    exit: 0,
    failures: [],
    preExisting: [],
    cached: false,
    verdict: "pass",
    minutes: 1,
    logPath: "scratch/live-check.log",
  });
  await expect(check).toHaveAccessibleName(/^C-live check · pass/);
  expect(errors).toEqual([]);
});

test("the earlier fixture keeps its graph", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);
  await page.goto(`/runs/${state().fixture.id}`);
  await expect(page.getByRole("region", { name: "Run flow" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^M1\.L1 worker\. Done/ })).toBeVisible();
  expect(errors).toEqual([]);
});
