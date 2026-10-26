import { afterEach, describe, expect, it } from "bun:test";
import { startRun } from "../../src/services/run-service.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, testView } from "./helpers.ts";

afterEach(snapshotEnv());

describe("run_start and the decision model (plan 44 D25, D27)", () => {
  const input = () => ({ repo: tempRepo(), title: "t", aLines: ["A1 it works"] });

  it("a run without a decision model is refused", async () => {
    withHome();
    const unset = fakeDeps({
      view: testView({ decision: { url: null, model: "m", minConfidence: 0.8 } }),
    });
    await expect(startRun(unset, input())).rejects.toMatchObject({
      code: "E_DECISION_UNSET",
      fix: expect.stringContaining("catherd profile set decision.url https://<your-gateway>/v1"),
    });
    const noModel = fakeDeps({
      view: testView({ decision: { url: "https://decider.example/v1", model: null, minConfidence: 0.8 } }),
    });
    await expect(startRun(noModel, input())).rejects.toMatchObject({ code: "E_DECISION_UNSET" });

    let probes = 0;
    const deps = fakeDeps();
    deps.routing.probe = async () => {
      probes++;
      return { ok: false, error: "http 401" };
    };
    await expect(startRun(deps, input())).rejects.toMatchObject({
      code: "E_DECISION_PROBE",
      message: expect.stringContaining("http 401"),
    });
    expect(probes).toBe(1);

    deps.routing.probe = async () => {
      probes++;
      return { ok: true, latencyMs: 3 };
    };
    const started = await startRun(deps, input());
    expect(started.run).toBeTruthy();
    expect(probes).toBe(2);
  });
});
