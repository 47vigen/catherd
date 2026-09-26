import { describe, expect, it } from "bun:test";
import { terminalAsk } from "../../src/entry/prompt.ts";

class Exited extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
const exit = (code: number): never => {
  throw new Exited(code);
};

/** A readline stand-in: `question` answers from `answer`, and `on` keeps the SIGINT listener. */
function fakeRl(answer: () => Promise<string>) {
  const listeners: Record<string, () => void> = {};
  const rl = {
    question: (_q: string) => answer(),
    on(event: string, f: () => void) {
      listeners[event] = f;
      return rl;
    },
  };
  return { rl, listeners };
}

describe("terminalAsk (catherd init's questions on a terminal)", () => {
  it("returns the trimmed answer", async () => {
    const { rl } = fakeRl(async () => "  fast \n");
    expect(await terminalAsk(rl, exit)("Profile? ")).toBe("fast");
  });

  it("exits 130 when Ctrl-C aborts the question, as the secret prompt does", async () => {
    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const { rl } = fakeRl(() => Promise.reject(abort));
    const e = await terminalAsk(rl, exit)("Profile? ").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Exited);
    expect((e as Exited).code).toBe(130);
  });

  it("exits 130 on readline's SIGINT", () => {
    const { rl, listeners } = fakeRl(() => new Promise(() => {}));
    terminalAsk(rl, exit);
    expect(() => listeners.SIGINT?.()).toThrow("exit 130");
  });

  it("passes any other failure on", async () => {
    const { rl } = fakeRl(() => Promise.reject(new Error("stdin closed")));
    expect(terminalAsk(rl, exit)("Profile? ")).rejects.toThrow("stdin closed");
  });
});
