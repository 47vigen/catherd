import { afterEach, describe, expect, it } from "bun:test";
import { hostProbe, probeTwice } from "../../src/infra/host-probe.ts";

const saved = hostProbe.retryMs;
afterEach(() => {
  hostProbe.retryMs = saved;
});

describe("a host probe (plan 23)", () => {
  it("retries once before it calls the host blocked", async () => {
    hostProbe.retryMs = 0;
    const answers = [false, true];
    let asked = 0;
    const r = await probeTwice(
      async () => answers[asked++] as boolean,
      (ok) => ok,
    );
    expect(r).toEqual({ result: true, attempts: 2 });
    // a first answer that passes is the answer; a second failure is the verdict
    expect(
      await probeTwice(
        async () => true,
        (ok) => ok,
      ),
    ).toEqual({ result: true, attempts: 1 });
    expect(
      await probeTwice(
        async () => false,
        (ok) => ok,
      ),
    ).toEqual({ result: false, attempts: 2 });
  });

  it("waits five seconds between the two tries by default", () => {
    expect(saved).toBe(5_000);
  });
});
