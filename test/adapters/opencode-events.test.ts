import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentsDir,
  installAgents,
  OPENCODE_AGENT_FILES,
  staleAgents,
} from "../../src/adapters/opencode/agents.ts";
import {
  foldOpencodeEvents,
  isV1Error,
  opencodeTokens,
  parseOpencodeLine,
} from "../../src/adapters/opencode/events.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "opencode");
const fold = (n: string) =>
  foldOpencodeEvents(
    readFileSync(join(FX, n), "utf8")
      .split("\n")
      .filter((l) => l.trim()),
  );
afterEach(snapshotEnv());

describe("opencode events", () => {
  it("counts cache reads and writes as input and reasoning as output (spec §4.3)", () => {
    expect(opencodeTokens({ input: 10, output: 2, reasoning: 3, cache: { read: 5, write: 1 } })).toEqual({
      input: 16,
      cached: 5,
      output: 5,
    });
    expect(opencodeTokens(undefined)).toEqual({ input: 0, cached: 0, output: 0 });
  });

  it("sums step_finish tokens, and takes the reply from the last message only", () => {
    expect(fold("shell-ok.jsonl")).toMatchObject({
      thread: "ses_f2671cde4ffe4VbeG6dKWzM2vi",
      tokens: { input: 6505, cached: 488, output: 41 },
      error: null,
      reply: "The command ran successfully and output `listed`.\n\nDONE",
    });
    expect(fold("ok-simple.jsonl")).toMatchObject({
      tokens: { input: 0, cached: 0, output: 0 },
      reply: "hello",
    });
  });

  it("names the declined tool call behind a rejection abort", () => {
    expect(fold("permission-rejected.jsonl")).toMatchObject({
      error: { type: "aborted", message: "Step interrupted" },
      declined: "read <scratch>/outside.txt",
      limit: false,
    });
  });

  it("marks quota and rate-limit errors as limits, and a v1 error as too old", () => {
    expect(fold("quota.jsonl")).toMatchObject({ limit: true, error: { type: "provider.quota" } });
    expect(fold("rate-limit.jsonl").limit).toBe(true);
    expect(fold("variant-unavailable.jsonl")).toMatchObject({
      limit: false,
      error: { type: "provider.no-route" },
    });
    expect(fold("v1-model-hash-error.jsonl")).toMatchObject({ tooOld: true, error: { type: null } });
    expect(isV1Error(parseOpencodeLine('{"type":"error","error":{"type":"aborted"}}') ?? {})).toBe(false);
  });

  it("reads nothing from a line that is not a JSON object", () => {
    expect(parseOpencodeLine("hello")).toBeNull();
    expect(parseOpencodeLine("[1]")).toBeNull();
    expect(parseOpencodeLine('{"type":')).toBeNull();
  });
});

describe("opencode agents", () => {
  it("installs the three catherd agents once, and leaves the user's own agents alone", () => {
    const root = join(withHome(), "xdg");
    mkdirSync(agentsDir(root), { recursive: true });
    writeFileSync(join(agentsDir(root), "mine.md"), "mine");
    expect(staleAgents(root)).toEqual(["catherd-ro", "catherd-worker", "catherd-full"]);
    expect(installAgents(root)).toBe(true);
    expect(installAgents(root)).toBe(false);
    expect(staleAgents(root)).toEqual([]);
    expect(readFileSync(join(agentsDir(root), "mine.md"), "utf8")).toBe("mine");
    writeFileSync(join(agentsDir(root), "catherd-ro.md"), "edited");
    expect(staleAgents(root)).toEqual(["catherd-ro"]);
    expect(installAgents(root)).toBe(true);
  });

  it("denies everything but reading to catherd-ro, and commits and pushes to catherd-worker", () => {
    const ro = OPENCODE_AGENT_FILES["catherd-ro"] as string;
    expect(ro).toContain("mode: primary");
    expect(ro.indexOf('action: "*", resource: "*", effect: deny')).toBeLessThan(
      ro.indexOf('action: "read", resource: "*", effect: allow'),
    );
    expect(ro).toContain('action: "edit", resource: "*", effect: deny');
    expect(OPENCODE_AGENT_FILES["catherd-worker"]).toContain(
      'action: "shell", resource: "git push*", effect: deny',
    );
  });
});
