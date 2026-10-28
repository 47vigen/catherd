import { afterEach, describe, expect, it } from "bun:test";
import { startRun } from "../../src/services/run-service.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());

describe("run_start without a decision model (plan 49)", () => {
  it("starts a run on the profile's ladders alone: no decision model is named or asked", async () => {
    withHome();
    const started = await startRun(fakeDeps(), { repo: tempRepo(), title: "t", aLines: ["A1 it works"] });
    expect(started.run).toBeTruthy();
  });
});
