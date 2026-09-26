import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { BackendAdapter, FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { ACCESS, type RunStatus, type Tokens } from "../../src/domain/record.ts";

export interface ContractCase {
  name: string;
  fixture: string;
  reply?: string;
  stderr?: string;
  /** the CLI's exit code; by default 0 for an ok case and 1 otherwise */
  exitCode?: number;
  expect: { status: RunStatus; thread?: string | null; tokens?: Tokens; reply?: string };
}

/** How the adapter's argv reads: its subcommand words and the flags that take a value. */
export interface ArgvShape {
  subcommands: string[];
  valueFlags: string[];
  /** a valid resume thread for this backend */
  thread: string;
}

/**
 * The positionals of `args`: every word that is neither a subcommand, a flag nor a value flag's value.
 * Words after `--` are positionals by definition; a positional before `--` is a violation.
 */
export function strayPositionals(args: string[], shape: ArgvShape): string[] {
  const stray: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") break;
    if (a.startsWith("-")) {
      if (shape.valueFlags.includes(a)) i++;
      continue;
    }
    if (!shape.subcommands.includes(a)) stray.push(a);
  }
  return stray;
}

/** Every adapter must pass this before it ships (spec §11.2). */
export function runAdapterContract(
  adapter: BackendAdapter,
  rung: string,
  cases: ContractCase[],
  shape: ArgvShape,
): void {
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

    it("keeps every positional after `--`, fresh, resumed and isolated", () => {
      for (const access of ACCESS)
        for (const thread of [null, shape.thread])
          for (const isolated of [false, true]) {
            const args = adapter.plan(req({ access, thread, isolated })).args;
            expect(strayPositionals(args, shape)).toEqual([]);
          }
    });

    it("passes a resume thread only as a flag's value or after `--`", () => {
      const args = adapter.plan(req({ thread: shape.thread })).args;
      const at = args.indexOf(shape.thread);
      expect(at).toBeGreaterThan(0);
      const afterDashes = args.indexOf("--") !== -1 && at > args.indexOf("--");
      expect(afterDashes || shape.valueFlags.includes(args[at - 1] as string)).toBe(true);
      expect(adapter.resume.threadPattern.test(shape.thread)).toBe(true);
    });

    it("refuses a flag-shaped thread with E_ADMIT_THREAD", () => {
      for (const thread of ["--help", "-s", "--dangerously-skip-permissions"]) {
        let code: string | null = null;
        try {
          adapter.plan(req({ thread }));
        } catch (e) {
          code = isCatherdError(e) ? e.code : String(e);
        }
        expect(code).toBe("E_ADMIT_THREAD");
      }
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
        stderr: c.stderr ?? "",
        exit: {
          code: c.exitCode ?? (c.expect.status === "ok" ? 0 : 1),
          signal: null,
          reason: "exited",
          endedAt: "x",
        },
        startedAtMs: 0,
      };
      const o = adapter.finalize(run);
      expect(o.status).toBe(c.expect.status);
      if (c.expect.thread !== undefined) expect(o.thread).toBe(c.expect.thread);
      if (c.expect.tokens) expect(o.tokens).toEqual(c.expect.tokens);
      if (c.expect.reply !== undefined) expect(o.reply).toBe(c.expect.reply);
      expect(o.tokens.input).toBeGreaterThanOrEqual(o.tokens.cached);
      expect(o.error === null).toBe(o.status === "ok");
    });

    it("parses every fixture line without throwing", () => {
      for (const c of cases)
        for (const line of readFileSync(c.fixture, "utf8").split("\n"))
          expect(() => adapter.parse(line)).not.toThrow();
      expect(adapter.parse("not json")).toEqual({});
      expect(adapter.parse('{"type":')).toEqual({});
    });
  });
}
