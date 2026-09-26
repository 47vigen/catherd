import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { assertId, parseRung } from "../domain/ids.ts";
import type { RunRecord } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { gitToplevel } from "../infra/git.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { dispatchState, type DispatchState, latestDispatch } from "./dispatches.ts";
import type { Deps } from "./ports.ts";
import {
  type AgentRun,
  appendAgentRun,
  createRun,
  findRun,
  knowledgeFile,
  readRecords,
  runFile,
} from "./run-store.ts";
import { refreshState } from "./state.ts";

export async function startRun(
  deps: Deps,
  i: { repo: string; title: string; aLines: string[] },
): Promise<{ run: string; dir: string; hints?: string[] }> {
  const top = await gitToplevel(i.repo);
  if (!top)
    throw new CatherdError("E_IO_PATH", `${i.repo} is not inside a git repository`, {
      fix: "pass the path of the repository to work in",
    });
  const run = createRun({
    repo: top,
    title: i.title,
    aLines: i.aLines,
    version: deps.version,
    now: new Date(deps.now()),
  });
  // a failed state.md refresh never fails the start: the run exists and is usable, so a retry would orphan it
  const { hints } = await refreshState(run);
  return { run: run.id, dir: run.dir, ...(hints.length ? { hints } : {}) };
}

export function writeRunFile(i: { run: string; path: string; content: string }): {
  path: string;
  bytes: number;
} {
  const file = runFile(findRun(i.run), i.path, "write");
  writeTextAtomic(file, i.content);
  return { path: file, bytes: Buffer.byteLength(i.content) };
}

export function readRunFile(i: { run: string; path: string }): string {
  const file = runFile(findRun(i.run), i.path, "read");
  if (!existsSync(file))
    throw new CatherdError("E_IO_PATH", `no file ${i.path} in the run folder`, {
      fix: "pass a path relative to the run folder",
    });
  return readFileSync(file, "utf8");
}

/** state.md's new text, or the hint `state.md not refreshed: <message>` (the note is kept in state.json). */
export async function setNext(i: { run: string; next: string }): Promise<string> {
  const { text, hints } = await refreshState(findRun(i.run), { next: i.next });
  return text ?? hints.join("\n");
}

const CAP_LINES = 250;
const CAP_CHARS = 20_000;

export function capReply(reply: string, path: string): string {
  const lines = reply.split("\n");
  const head = lines.length > CAP_LINES ? lines.slice(0, CAP_LINES).join("\n") : reply;
  if (head === reply && reply.length <= CAP_CHARS) return reply;
  return `${head.slice(0, CAP_CHARS)}\n[capped: the full reply is ${path}]`;
}

/** A role's latest dispatch: its record once finished, and its capped reply. Reads only. */
export function result(
  deps: Deps,
  i: { run: string; name: string },
): {
  name: string;
  state: DispatchState | null;
  record: RunRecord | null;
  reply: string;
  replyPath: string | null;
} {
  const run = findRun(i.run);
  assertId("role name", i.name);
  const d = latestDispatch(run, i.name);
  if (!d)
    throw new CatherdError("E_RUN_NOT_FOUND", `${i.name} was never dispatched in this run`, {
      fix: "status(run) lists the roles",
    });
  const record = readRecords(run).records.find((r) => r.dispatchId === d.admit.dispatchId) ?? null;
  const reply = dispatchPaths(d.dir).reply;
  const text = existsSync(reply) ? readFileSync(reply, "utf8") : "";
  return {
    name: i.name,
    state: record ? "finished" : dispatchState(d, deps.now()),
    record,
    reply: capReply(text, relative(run.dir, reply)),
    replyPath: relative(run.dir, reply),
  };
}

/** Spec §4.6: what a native Claude subagent used, as the Agent tool reported it; counted in the budget. */
export function recordAgentRun(
  deps: Deps,
  i: {
    run: string;
    name: string;
    role: Role;
    rung: string;
    totalTokens: number;
    costUsd?: number;
    durationMs?: number;
    status?: AgentRun["status"];
  },
): AgentRun {
  const run = findRun(i.run);
  assertId("role name", i.name);
  if (parseRung(i.rung).backend !== "claude")
    throw new CatherdError("E_ADMIT_RUNG", `${i.rung} is not a native Claude rung`, {
      fix: "record_agent_run is for Agent subagents; dispatch records every other run itself",
    });
  const row: AgentRun = {
    at: new Date(deps.now()).toISOString(),
    name: i.name,
    role: i.role,
    rung: i.rung,
    agent: deps.profiles.agentFor(i.role, i.rung),
    totalTokens: i.totalTokens,
    costUsd: i.costUsd ?? null,
    secs: i.durationMs === undefined ? null : Math.round(i.durationMs / 1000),
    status: i.status ?? "ok",
  };
  appendAgentRun(run, row);
  return row;
}

/** What past runs of the repo learned; `repo` may be any path inside it. */
export async function readKnowledge(repo: string): Promise<string> {
  const top = await gitToplevel(repo);
  if (!top)
    throw new CatherdError("E_IO_PATH", `${repo} is not inside a git repository`, {
      fix: "pass the path of the repository",
    });
  const file = knowledgeFile(top);
  return existsSync(file) ? readFileSync(file, "utf8") : "catherd: no knowledge recorded yet for this repo";
}
