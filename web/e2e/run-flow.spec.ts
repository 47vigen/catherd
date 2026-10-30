import { mkdirSync, writeFileSync } from "node:fs";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { appendEvent, consoleErrors, signIn, state } from "./helpers";

const FLOW_LABELS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9-a-long-ledger-task-id-that-truncates"];

async function setTheme(page: Page, colorScheme: "light" | "dark") {
  await page.getByRole("button", { name: "Theme" }).click();
  await page.getByRole("menuitemradio", { name: colorScheme === "light" ? "Light" : "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
}

/** Signs in at a desktop width, sets the theme, then opens the seeded flow run at `viewport`. */
async function openFlow(page: Page, colorScheme: "light" | "dark", viewport = { width: 1440, height: 1000 }) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page);
  await setTheme(page, colorScheme);
  await page.setViewportSize(viewport);
  await page.goto(`/runs/${state().flow.id}`);
  const flow = page.getByRole("region", { name: "Run flow" });
  await expect(flow).toBeVisible();
  await expect(flow.locator("svg[aria-label='Run graph']")).toHaveCount(0);
  return flow;
}

const timelineOf = (page: Page) => page.getByRole("region", { name: "Flow timeline" });

const rowLabels = (flow: Locator) => flow.locator('svg[aria-label="Flow rows"] foreignObject > div > span:first-child');

const trait = (track: Locator) => track.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));

const overflow = async (track: Locator) => {
  const { client, scroll } = await trait(track);
  return scroll - client;
};

/** The track fits the whole run: no local horizontal scrolling is needed. */
async function expectFit(track: Locator) {
  await expect.poll(async () => overflow(track)).toBeLessThanOrEqual(1);
}

const pageWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);

/** Records the longest entrance animation the next modal runs, while it runs (the attribute is gone afterwards). */
async function watchOpening(page: Page) {
  await page.evaluate(() => {
    const seconds = (value: string) =>
      value.split(",").flatMap((part) => {
        const text = part.trim();
        const n = Number.parseFloat(text);
        return Number.isFinite(n) ? [text.endsWith("ms") ? n : n * 1000] : [];
      });
    const probe = { duration: 0 };
    const read = () => {
      for (const el of document.querySelectorAll<HTMLElement>(".modal__container, [role='dialog']")) {
        if (!el.getClientRects().length) continue;
        const style = getComputedStyle(el);
        probe.duration = Math.max(
          probe.duration,
          ...seconds(style.animationDuration),
          ...seconds(style.transitionDuration),
        );
      }
    };
    new MutationObserver(read).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-entering", "data-exiting"],
    });
    (globalThis as unknown as { __flowOpening: typeof probe }).__flowOpening = probe;
  });
}

const openingMs = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { __flowOpening?: { duration: number } }).__flowOpening?.duration ?? 0);

for (const colorScheme of ["light", "dark"] as const) {
  test(`the completed flow fits, reads cleanly and opens full screen in ${colorScheme} mode`, async ({
    page,
  }, testInfo) => {
    const errors = consoleErrors(page);
    const flow = await openFlow(page, colorScheme);
    const track = timelineOf(page);
    await expectFit(track);
    expect(await pageWidth(page)).toBeLessThanOrEqual(1440);

    // One fixed-height line per ledger row: id and inline state chip, the goal only in the tooltip and the drawer.
    const labels = rowLabels(flow);
    await expect(labels.filter({ hasText: /^L/ })).toHaveText(FLOW_LABELS);
    const rows = await labels.evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          text: el.textContent ?? "",
          height: Math.round(rect.height * 10) / 10,
          lines: el.getClientRects().length,
          truncated: el.scrollWidth > el.clientWidth,
          whiteSpace: style.whiteSpace,
        };
      }),
    );
    expect(new Set(rows.map((row) => row.height)).size).toBe(1);
    expect(rows.every((row) => row.lines === 1 && row.whiteSpace === "nowrap")).toBe(true);
    expect(rows.find((row) => row.text === FLOW_LABELS.at(-1))?.truncated).toBe(true);
    await expect(flow.locator('svg[aria-label="Flow rows"] div[title*="L9-a-long"]')).toHaveAttribute(
      "title",
      /full goal stays in the tooltip/,
    );
    for (const [state, count] of [
      ["done", 2],
      ["review", 2],
      ["todo", 3],
      ["blocked", 2],
    ] as const)
      await expect(flow.locator('svg[aria-label="Flow rows"]').getByText(state, { exact: true })).toHaveCount(count);

    // The run's own figures, and the header counts the ledger rather than the graph's milestones.
    await expect(flow.locator('dl[aria-label="Run statistics"]')).toHaveCount(0);
    await expect(page.getByText("Took", { exact: true }).locator("xpath=..")).toContainText("45m 00s");
    const tile = page.locator("section", {
      has: page.getByRole("heading", { level: 3, name: "Run flow", exact: true }),
    });
    await expect(tile).toHaveCount(1);
    await expect(tile.locator("header")).toContainText("of 9");
    await expect(tile.locator("header")).not.toContainText("failed of");
    await expect(page.getByText("done of 9 ledger tasks", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Milestones" })).toHaveCount(0);
    await expect(page.getByText(/\bmilestones?\b/i)).toHaveCount(0);

    // Bars carry the task id only: role is the colour, status the edge, the rest on hover.
    const bar = (name: RegExp) => track.getByRole("button", { name });
    const t1 = bar(/^T1 worker · limit/);
    const t2 = bar(/^T2 writer · complete/);
    const t4 = bar(/^T4 reviewer · cancelled/);
    const t7 = bar(/^T7 worker/);
    const c1 = bar(/^C1 check/);
    await expect(t1).toHaveAttribute("data-tone", "warning");
    await expect(t1.locator("rect").last()).toHaveClass(/stroke-warning/);
    await expect(t4).toHaveAttribute("data-tone", "danger");
    await expect(t4.locator("rect").last()).toHaveClass(/stroke-danger/);
    await expect(c1).toHaveAttribute("data-tone", "danger");
    await expect(c1.locator("rect").last()).toHaveClass(/stroke-danger/);
    expect(await t2.getAttribute("data-tone")).toBeNull();
    await expect(t2.locator("rect").last()).toHaveClass(/stroke-transparent/);
    await expect(t7).toHaveAccessibleName(/Rung changed/);
    await expect(track.locator("text").filter({ hasText: /^turn 1$/ })).toHaveCount(1);
    const texts = await track
      .locator("text")
      .evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? "").filter(Boolean));
    expect(texts).toContain("T1");
    expect(texts.some((text) => /worker|writer|reviewer|verifier|researcher|artist|check/i.test(text))).toBe(false);

    await t1.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("T1 · worker");
    await expect(tooltip).toContainText("limit");

    // Idle is a solid band per reason; the seeded run has all four, quota included.
    for (const reason of ["owner", "quota", "check", "gap"] as const)
      await expect(track.locator(`[data-idle-reason="${reason}"]`).first()).toBeAttached();
    const quota = track.locator('[data-idle-reason="quota"]');
    await expect(quota).toHaveCount(1);
    expect((await quota.locator("rect").last().boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(30);
    await quota.hover();
    await expect(tooltip).toContainText("Idle · Quota");
    await expect(tooltip).toContainText("min");

    // The reused drawer: dispatch goal, a check's new and inherited failures, and an architect turn's why.
    const drawer = page.getByRole("dialog");
    await t1.click();
    await expect(drawer).toContainText("T1");
    await expect(drawer).toContainText("Flow task 1");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await c1.click();
    await expect(drawer).toContainText("new failure");
    await expect(drawer).toContainText("inherited failure");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await bar(/^architect-1 architect/).click();
    await expect(drawer).toContainText("Plan the flow tasks");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    const screenshot = `test-results/flow-${colorScheme}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`flow-${colorScheme}`, { path: screenshot, contentType: "image/png" });

    // Full screen: titled "Run flow", and its entrance is no slower than 150ms.
    await watchOpening(page);
    await flow.getByRole("button", { name: "Full screen" }).click();
    const modal = page.getByRole("dialog", { name: "Run flow" });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("heading", { name: "Run flow" })).toBeVisible();
    await expect(modal.getByRole("region", { name: "Run flow" })).toBeVisible();
    expect(await openingMs(page)).toBeLessThanOrEqual(150);
    const fullShot = `test-results/flow-fullscreen-${colorScheme}.png`;
    await page.screenshot({ path: fullShot, fullPage: true });
    await testInfo.attach(`flow-fullscreen-${colorScheme}`, { path: fullShot, contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    expect(errors).toEqual([]);
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`the flow fits and scrolls inside its card at 375x812 in ${colorScheme} mode`, async ({ page }, testInfo) => {
    const errors = consoleErrors(page);
    const flow = await openFlow(page, colorScheme, { width: 375, height: 812 });
    const track = timelineOf(page);
    await expectFit(track);
    expect(await pageWidth(page)).toBeLessThanOrEqual(375);

    // A 120px label column, one line per row, the long id truncated (its full text stays in the tooltip).
    const column = await flow.locator('svg[aria-label="Flow rows"]').boundingBox();
    expect(column?.width ?? 0).toBeGreaterThanOrEqual(110);
    expect(column?.width ?? 0).toBeLessThanOrEqual(130);
    const longId = rowLabels(flow).filter({ hasText: /^L9-a-long/ });
    await expect(longId).toHaveCount(1);
    const long = await longId.evaluate((el) => ({
      height: Math.round(el.getBoundingClientRect().height),
      lines: el.getClientRects().length,
      truncated: el.scrollWidth > el.clientWidth,
    }));
    expect(long.lines).toBe(1);
    expect(long.truncated).toBe(true);

    // The legend is one scrollable line, not three wrapped ones.
    const legend = flow.locator('[aria-label="Flow legend"]');
    const legendBox = await legend.boundingBox();
    expect(legendBox?.height ?? 0).toBeLessThan(28);
    expect(["auto", "scroll"]).toContain(await legend.evaluate((el) => getComputedStyle(el).overflowX));
    for (const name of ["Zoom out", "Zoom in", "Fit"]) await expect(flow.getByRole("button", { name })).toBeVisible();

    // Zoom in keeps the page still and reveals local scrolling, which drag pans; Fit restores the fitted run.
    await flow.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(async () => overflow(track)).toBeGreaterThan(40);
    expect(await pageWidth(page)).toBeLessThanOrEqual(375);
    const box = await track.boundingBox();
    if (!box) throw new Error("the flow timeline has no box");
    const before = await track.evaluate((el) => el.scrollLeft);
    await page.mouse.move(box.x + box.width / 2, box.y + 4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + 4, { steps: 4 });
    await page.mouse.up();
    expect(await track.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
    expect(await pageWidth(page)).toBeLessThanOrEqual(375);
    const labelX = (await rowLabels(flow).filter({ hasText: /^L1$/ }).boundingBox())?.x ?? -1;
    await track.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect.poll(() => track.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect((await rowLabels(flow).filter({ hasText: /^L1$/ }).boundingBox())?.x ?? -2).toBeCloseTo(labelX, 0);
    await flow.getByRole("button", { name: "Fit" }).click();
    await expectFit(track);
    expect(await pageWidth(page)).toBeLessThanOrEqual(375);

    const screenshot = `test-results/flow-phone-${colorScheme}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`flow-phone-${colorScheme}`, { path: screenshot, contentType: "image/png" });
    expect(errors).toEqual([]);
  });
}

test("the live flow updates from socket events, idle reasons included", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);
  const { flowLive: live } = state();
  await page.goto(`/runs/${live.id}`);
  await expect(page.locator('output[data-connected="true"]')).toBeVisible();
  const track = timelineOf(page);
  const worker = track.getByRole("button", { name: /^T1 worker/ });
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
  const check = track.getByRole("button", { name: /C-live/ });
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
  // No role works and the check is still open: the idle row says so, without a reload.
  await expect(track.locator('[data-idle-reason="check"]').first()).toBeAttached();
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
  // The waited-on interval stays in the row as history after the check closes.
  await expect(track.locator('[data-idle-reason="check"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("the earlier fixture keeps its graph", async ({ page }) => {
  const errors = consoleErrors(page);
  await signIn(page);
  await page.goto(`/runs/${state().fixture.id}`);
  await expect(page.getByRole("region", { name: "Run flow" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^M1\.L1 worker\. Done/ })).toBeVisible();
  // The milestone card still belongs to a graph run.
  await expect(page.getByRole("heading", { name: "Milestones" })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 375, height: 812 },
]) {
  test(`native touch preserves the stationary finger at ${viewport.width}px`, async ({ page }, testInfo) => {
    const errors = consoleErrors(page);
    await openFlow(page, "light", viewport);
    const track = timelineOf(page);
    await track.scrollIntoViewIfNeeded();
    const box = await track.boundingBox();
    if (!box) throw new Error("the flow timeline has no box");
    const first = viewport.width === 375 ? 50 : 200;
    const second = first * 2;
    const read = () =>
      track.evaluate((el) => ({
        width: Number(el.querySelector("svg")!.getAttribute("width")),
        scroll: el.scrollLeft,
      }));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
    const evidence = [];
    try {
      // Repeat from an already zoomed, panned timeline to catch baseline and scroll-rounding drift.
      for (let gesture = 0; gesture < 2; gesture++) {
        const before = await read();
        const timeUnderFinger = (before.scroll + first - 16) / (before.width - 32);
        const y = box.y + 4;
        const point = (x: number, id: number) => ({ x: box.x + x, y, id });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [point(first, 1), point(second, 2)],
        });
        for (let step = 1; step <= 10; step++) {
          await cdp.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [point(first, 1), point(second + (first * step) / 10, 2)],
          });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(async () => (await read()).width).toBeCloseTo((before.width - 32) * 2 + 32, 0);
        const after = await read();
        const actual = 16 + timeUnderFinger * (after.width - 32) - after.scroll;
        const error = Math.abs(actual - first);
        evidence.push({
          gesture,
          viewport,
          fingers: [first, second, first, second + first],
          before,
          after,
          expected: first,
          actual,
          error,
        });
        expect(error).toBeLessThanOrEqual(2);
      }
    } finally {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await cdp.detach();
    }
    mkdirSync("test-results/flow-fix", { recursive: true });
    const path = `test-results/flow-fix/native-${viewport.width}.json`;
    writeFileSync(path, JSON.stringify(evidence, null, 2));
    await testInfo.attach("native touch anchor", { path, contentType: "application/json" });
    expect(errors).toEqual([]);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`axis labels stay inside the SVG in ${theme} at ${viewport.width}px`, async ({ page }, testInfo) => {
      const errors = consoleErrors(page);
      await openFlow(page, theme, viewport);
      const evidence = [];
      for (const kind of ["completed", "live"] as const) {
        await page.goto(`/runs/${kind === "completed" ? state().flow.id : state().flowLive.id}`);
        for (const fullscreen of [false, true]) {
          if (fullscreen) await page.getByRole("button", { name: "Full screen" }).click();
          const track = timelineOf(page);
          await expectFit(track);
          await track.scrollIntoViewIfNeeded();
          const labels = await track.evaluate((el) => {
            const svg = el.querySelector("svg")!;
            const bounds = svg.getBoundingClientRect();
            return [...el.querySelectorAll<SVGTextElement>(":scope > svg > g > text")].map((label) => {
              const box = label.getBoundingClientRect();
              return {
                text: label.textContent,
                left: box.left - bounds.left,
                right: box.right - bounds.left,
                width: bounds.width,
              };
            });
          });
          const lastTick = viewport.width === 375 && !fullscreen ? "30m 00s" : "45m 00s";
          expect(labels.some((label) => label.text === (kind === "live" ? "Now" : lastTick))).toBe(true);
          for (const label of labels) {
            expect(label.left).toBeGreaterThanOrEqual(0);
            expect(label.right).toBeLessThanOrEqual(label.width);
          }
          for (let i = 1; i < labels.length; i++) expect(labels[i]!.left).toBeGreaterThan(labels[i - 1]!.right);
          expect(await pageWidth(page)).toBeLessThanOrEqual(viewport.width);
          evidence.push({ kind, fullscreen, labels });
          const path = `test-results/flow-fix/${kind}-${theme}-${viewport.width}-${fullscreen ? "full" : "card"}.png`;
          await track.screenshot({ path });
          await testInfo.attach(`${kind} axis`, { path, contentType: "image/png" });
          if (fullscreen) await page.keyboard.press("Escape");
        }
      }
      writeFileSync(`test-results/flow-fix/labels-${theme}-${viewport.width}.json`, JSON.stringify(evidence, null, 2));
      expect(errors).toEqual([]);
    });
  }
}
