import { afterEach, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { laneSet, ownsAdd, setHeaderLine } from "../../src/services/lane-edit.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const read = (file: string) => readFileSync(file, "utf8");

it("sets one header line in place, or adds it under the title", () => {
  const text = "# M1.L1 — x\nOwns: a.ts\n**Fast check:** `go test`\n\nbody\n";
  expect(setHeaderLine(text, "Fast check", "pnpm check && go test")).toBe(
    "# M1.L1 — x\nOwns: a.ts\nFast check: pnpm check && go test\n\nbody\n",
  );
  expect(setHeaderLine(text, "After", "M1.L0")).toBe(
    "# M1.L1 — x\nAfter: M1.L0\nOwns: a.ts\n**Fast check:** `go test`\n\nbody\n",
  );
});

it("sets a header line, never a body line that shares its label", () => {
  const text = "# M1.L1 — x\n\nOwns: a.ts\n\n## Behaviour\nAfter: the handler returns 404.\n";
  expect(setHeaderLine(text, "After", "M1.L0")).toBe(
    "# M1.L1 — x\n\nAfter: M1.L0\nOwns: a.ts\n\n## Behaviour\nAfter: the handler returns 404.\n",
  );
  expect(setHeaderLine(text, "Owns", "b.ts")).toBe(
    "# M1.L1 — x\n\nOwns: b.ts\n\n## Behaviour\nAfter: the handler returns 404.\n",
  );
});

it("lane_set writes a valid line, and refuses a wrong value without touching the file", async () => {
  const { run } = freshRun();
  const file = writeLane(run, "M1.L1", ["src/a.ts"]);
  const deps = fakeDeps();
  const r = await laneSet(deps, { run: run.id, lane: "M1.L1", field: "fast_check", value: "pnpm check" });
  expect(r.header.fastCheck).toBe("pnpm check");
  expect(read(file)).toContain("Fast check: pnpm check\n");
  const before = read(file);
  await expect(
    laneSet(deps, { run: run.id, lane: "M1.L1", field: "difficulty", value: "medium" }),
  ).rejects.toMatchObject({ code: "E_LANE_INVALID" });
  await expect(
    laneSet(deps, { run: run.id, lane: "M1.L1", field: "owns", value: "../outside" }),
  ).rejects.toMatchObject({ code: "E_LANE_INVALID" });
  expect(read(file)).toBe(before);
  await expect(
    laneSet(deps, { run: run.id, lane: "M9.L9", field: "kind", value: "ui" }),
  ).rejects.toMatchObject({
    code: "E_LANE_INVALID",
  });
});

it("owns_add grows Owns with its why, refusing a path a running lane owns", async () => {
  const { run } = freshRun();
  const file = writeLane(run, "M1.L3", ["services/notification/"]);
  writeLane(run, "M1.L4", ["web/panels/"]);
  const deps = fakeDeps({ now: () => Date.parse("2026-10-02T10:00:00.000Z") });
  await fakeDispatch(run, { name: "worker-M1.L5", lane: "M1.L5", owns: ["kit/"] }, { proc: "self" });
  await expect(
    ownsAdd(deps, { run: run.id, lane: "M1.L3", paths: ["kit/x.go"], why: "the grep missed it" }),
  ).rejects.toMatchObject({ code: "E_ADMIT_OVERLAP" });
  const r = await ownsAdd(deps, {
    run: run.id,
    lane: "M1.L3",
    paths: ["./services/notification/cmd/audit_platform_test.go", "web/panels/a.tsx"],
    why: "the plan's grep excluded _test.go",
  });
  expect(r.added).toEqual(["services/notification/cmd/audit_platform_test.go", "web/panels/a.tsx"]);
  expect(r.hints).toEqual(["lanes/M1.L4.md also owns web/panels/a.tsx: do not run the two together"]);
  expect(read(file)).toContain(
    "Owns: services/notification/, services/notification/cmd/audit_platform_test.go, web/panels/a.tsx\n",
  );
  expect(read(file)).toContain(
    "Owns added 2026-10-02T10:00:00.000Z: services/notification/cmd/audit_platform_test.go, web/panels/a.tsx — the plan's grep excluded _test.go",
  );
  await expect(ownsAdd(deps, { run: run.id, lane: "M1.L3", paths: ["x"], why: " " })).rejects.toThrow(
    "owns_add needs a why",
  );
});

it("owns_add refuses a path a running lane was granted by an earlier owns_add", async () => {
  const { run } = freshRun();
  writeLane(run, "M1.L1", ["src/a.ts"]);
  writeLane(run, "M1.L2", ["web/"]);
  const deps = fakeDeps();
  await fakeDispatch(run, { name: "worker-M1.L1", lane: "M1.L1", owns: ["src/a.ts"] }, { proc: "self" });
  await ownsAdd(deps, { run: run.id, lane: "M1.L1", paths: ["src/a_test.ts"], why: "its test" });
  await expect(
    ownsAdd(deps, { run: run.id, lane: "M1.L2", paths: ["src/a_test.ts"], why: "mine too" }),
  ).rejects.toMatchObject({ code: "E_ADMIT_OVERLAP" });
});

it("holds a dispatch still running when its Owns grew to the new list, so the added path is not a violation", async () => {
  const { run } = freshRun();
  writeLane(run, "M1.L1", ["src/a.ts"]);
  const d = await fakeDispatch(
    run,
    {},
    { proc: "dead", exit: { code: 0, signal: null, reason: "exited", endedAt: new Date().toISOString() } },
  );
  await ownsAdd(fakeDeps(), { run: run.id, lane: "M1.L1", paths: ["src/a_test.ts"], why: "its test" });
  mkdirSync(join(run.meta.repo, "src"), { recursive: true });
  writeFileSync(join(run.meta.repo, "src", "a_test.ts"), "t");
  const record = await finalizeDispatch(run, d);
  expect(record.changedOwned).toEqual(["src/a_test.ts"]);
  expect(record.violations).toEqual([]);
});
