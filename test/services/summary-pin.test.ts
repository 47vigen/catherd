import { afterEach, expect, it } from "bun:test";
import { startRun } from "../../src/services/run-service.ts";
import { findRun } from "../../src/services/run-store.ts";
import { summarizeRun } from "../../src/services/summary.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, testView } from "./helpers.ts";

afterEach(snapshotEnv());

async function pinnedRun() {
  delete process.env.ANTHROPIC_API_KEY;
  const { repo } = freshRun();
  const deps = fakeDeps();
  const started = await startRun(deps, { repo, title: "pinned", aLines: ["A1 it works"] });
  return { deps, run: findRun(started.run) };
}

it("status shows the pinned budget, not the repo's", async () => {
  const { deps, run } = await pinnedRun();
  const pinned = { ...testView(), budget: { minutes: 600 } };
  deps.profiles.get = (name) => ({
    active: "other",
    here: "other",
    profiles: ["test", "other"],
    profile: name === "test" ? pinned : deps.view,
    enforcement: {},
  });
  Object.assign(deps.view, { name: "other", budget: { minutes: 5 } });
  expect(summarizeRun(deps, run).budget?.minutes?.cap).toBe(600);
});
