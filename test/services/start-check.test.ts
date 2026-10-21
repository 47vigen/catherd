import { afterEach, expect, it } from "bun:test";
import { join } from "node:path";
import { indexPath } from "../../src/infra/paths.ts";
import { readIndexFile } from "../../src/infra/slopalytics.ts";
import { startRun } from "../../src/services/run-service.ts";
import { findRun, listRuns } from "../../src/services/run-store.ts";
import { indexOf } from "../domain/shipped.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

it("refuses to start, creating no run, when a role has no usable rung", async () => {
  const { repo } = freshRun();
  const deps = fakeDeps();
  deps.routing.checkStart = async () => ({ unusable: ["reviewer"], index: null });
  await expect(startRun(deps, { repo, title: "t", aLines: ["A1 x"] })).rejects.toMatchObject({
    code: "E_CONFIG_INVALID",
    message: "the reviewer role has no usable rung on the Slopalytics index",
    fix: "catherd profile validate, then pick indexed pairs: catherd catalog list --role reviewer",
  });
  // freshRun made one run of its own; the refused start made none
  expect(listRuns().runs).toHaveLength(1);
});

it("names every role, in the plural", async () => {
  const { repo } = freshRun();
  const deps = fakeDeps();
  deps.routing.checkStart = async () => ({ unusable: ["reviewer", "writer"], index: null });
  await expect(startRun(deps, { repo, title: "t", aLines: ["A1 x"] })).rejects.toMatchObject({
    message: "the reviewer, writer roles have no usable rung on the Slopalytics index",
  });
});

it("copies the index it checked into the run", async () => {
  const { repo } = freshRun();
  const deps = fakeDeps();
  const index = indexOf({ "gpt-6-sol#high": 42 });
  deps.routing.checkStart = async () => ({ unusable: [], index });
  const started = await startRun(deps, { repo, title: "t", aLines: ["A1 x"] });
  expect(readIndexFile(join(findRun(started.run).dir, "slopalytics.json"))).toEqual(index);
});

it("pins nothing when the check read no index", async () => {
  const { repo } = freshRun();
  const deps = fakeDeps();
  const started = await startRun(deps, { repo, title: "t", aLines: ["A1 x"] });
  expect(readIndexFile(join(findRun(started.run).dir, "slopalytics.json"))).toBeNull();
  expect(readIndexFile(indexPath())).not.toBeNull();
});
