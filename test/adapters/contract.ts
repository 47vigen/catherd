import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { BackendAdapter, FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
import { ACCESS, type RunStatus, type Tokens } from "../../src/domain/record.ts";
import { parseRung } from "../../src/domain/ids.ts";

export interface ContractCase {
  name: string;
  fixture: string;
  reply?: string;
  expect: { status: RunStatus; thread?: string | null; tokens?: Tokens };
}

/** Every adapter must pass this before it ships (spec §11.2). */
export function runAdapterContract(adapter: BackendAdapter, rung: string, cases: ContractCase[]): void {
  const req = (over: Partial<RunRequest> = {}): RunRequest => ({
    rung: parseRung(rung),
    access: "workspace-write",
    thread: null,
    isolated: false,
    repo: "/repo",
    briefPath: "/d/brief.md",
    replyPath: "/d/reply.md",
    dispatchDir: "/d",
    ...over,
  });

  describe(`${adapter.id} adapter contract`, () => {
    it.each([...ACCESS])("plans a %s run without the brief in argv, in the repo", (access) => {
      const p = adapter.plan(req({ access }));
      expect(p.cwd).toBe("/repo");
      expect(p.args.some((a) => a.includes("brief"))).toBe(p.stdinPath === null);
      expect(p.env.PWD).toBeUndefined();
    });

    it("refuses a flag-shaped thread", () => {
      expect(() => adapter.plan(req({ thread: "--help" }))).toThrow();
    });

    it("declares enforcement for every access mode", () => {
      for (const a of ACCESS) expect(["enforced", "advisory"]).toContain(adapter.enforcement[a]);
    });

    it.each(cases)("finalizes $name", (c) => {
      const run: FinishedRun = {
        request: req(),
        eventLines: readFileSync(c.fixture, "utf8")
          .split("\n")
          .filter((l) => l.trim()),
        reply: c.reply ?? "x\nSTATUS: complete — ok",
        stderr: "",
        exit: { code: c.expect.status === "ok" ? 0 : 1, signal: null, reason: "exited", endedAt: "x" },
        startedAtMs: 0,
      };
      const o = adapter.finalize(run);
      expect(o.status).toBe(c.expect.status);
      if (c.expect.thread !== undefined) expect(o.thread).toBe(c.expect.thread);
      if (c.expect.tokens) expect(o.tokens).toEqual(c.expect.tokens);
      expect(o.tokens.input).toBeGreaterThanOrEqual(o.tokens.cached);
      expect(o.error === null).toBe(o.status === "ok");
    });

    it("parses every fixture line without throwing", () => {
      for (const c of cases)
        for (const line of readFileSync(c.fixture, "utf8").split("\n"))
          expect(() => adapter.parse(line)).not.toThrow();
      expect(adapter.parse("not json")).toEqual({});
    });
  });
}
