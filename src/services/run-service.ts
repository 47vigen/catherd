import { existsSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import { assertId, parseRung } from "../domain/ids.ts";
import { assertLaneValues } from "../domain/lane.ts";
import type { RunRecord } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import { awaitsCollect, dispatchPaths, endCollect, tryCollect } from "../infra/dispatch-dir.ts";
import { withFileLock } from "../infra/filelock.ts";
import { gitToplevel } from "../infra/git.ts";
import { writeJsonAtomic, writeTextAtomic } from "../infra/store.ts";
import {
  dispatchState,
  type DispatchState,
  latestDispatch,
  listDispatches,
  liveDispatches,
  recordHints,
} from "./dispatches.ts";
import type { Deps } from "./ports.ts";
import { assertNativeHost } from "./backends.ts";
import {
  type AgentRun,
  appendAgentRun,
  appendKnowledge,
  createRun,
  findRun,
  knowledgeFor,
  readRecords,
  runFile,
  type Run,
  runPaths,
  supersededBy,
  supersededFile,
} from "./run-store.ts";
import { protocolNext, protocolView } from "./protocol.ts";
import { writePin } from "./run-pin.ts";
import { claimRun, currentSession } from "./sessions.ts";
import { readNotes, refreshState } from "./state.ts";

/** The run `id` was superseded by, or undefined: an open run, or one that cannot be found. */
function nextInChain(id: string): string | undefined {
  try {
    return supersededBy(findRun(id))?.by;
  } catch {
    return undefined;
  }
}

/**
 * `runs supersede <run> --by <run>`: closes `run` with a pointer to the run that took it over (a planning
 * run handed to the execution run in a worktree). Status hides it; dispatch refuses it. A run with live
 * roles is refused: cancel them, or let them finish, first.
 */
export async function supersedeRun(
  deps: Deps,
  i: { run: string; by: string },
): Promise<{ run: string; by: string; at: string; hints?: string[] }> {
  const run = findRun(i.run);
  const by = findRun(i.by);
  if (run.id === by.id)
    throw new CatherdError("E_INPUT_INVALID", `run ${run.id} cannot supersede itself`, {
      fix: "pass the run that took over as --by",
    });
  // walk the chain the new pointer would join: any run it reaches back to `run` closes a cycle
  const seen = new Set<string>([by.id]);
  for (let hop = supersededBy(by)?.by; hop !== undefined && !seen.has(hop);) {
    if (hop === run.id)
      throw new CatherdError("E_INPUT_INVALID", `run ${by.id} is itself superseded by ${run.id}`, {
        fix: "supersede the older run by the newer one",
      });
    seen.add(hop);
    hop = nextInChain(hop);
  }
  // under the run's admission lock: a dispatch admitted meanwhile is either live here, or sees the pointer
  const at = await withFileLock(runPaths(run.dir).admission, () => {
    assertNoLiveRoles(
      deps,
      run,
      `cancel them (cancel(run, name)) or let them finish, then supersede ${run.id}`,
    );
    return writeSuperseded(deps, run, by.id);
  });
  return { run: run.id, by: by.id, at, ...(await supersededHints(run, by.id)) };
}

/** Held under `run`'s admission lock: no role of it may be live when it closes. */
function assertNoLiveRoles(deps: Deps, run: Run, fix: string): void {
  const live = liveDispatches(run, deps.now());
  if (live.length)
    throw new CatherdError(
      "E_INPUT_INVALID",
      `run ${run.id} still has live roles: ${live.map((d) => d.admit.name).join(", ")}`,
      { fix },
    );
}

/** Held under `run`'s admission lock: the pointer to the run that took it over; its time. */
function writeSuperseded(deps: Deps, run: Run, by: string): string {
  const when = new Date(deps.now()).toISOString();
  writeJsonAtomic(supersededFile(run), { schema: 1, by, at: when });
  return when;
}

async function supersededHints(run: Run, by: string): Promise<{ hints?: string[] }> {
  const { hints } = await refreshState(run, { next: `superseded by ${by}: continue there` });
  return hints.length ? { hints } : {};
}

export async function startRun(
  deps: Deps,
  i: { repo: string; title: string; aLines: string[]; from?: string },
): Promise<{
  run: string;
  dir: string;
  protocol: { next: string; checklist: string[] };
  hints?: string[];
}> {
  const top = await gitToplevel(i.repo);
  if (!top)
    throw new CatherdError("E_IO_PATH", `${i.repo} is not inside a git repository`, {
      fix: "pass the path of the repository to work in",
    });
  const open = async (): Promise<Run> => {
    const run = createRun({
      repo: top,
      title: i.title,
      aLines: i.aLines,
      version: deps.version,
      now: new Date(deps.now()),
      startedBy: currentSession(deps),
    });
    // spec 1.5 "Pinned per run": what the run starts on stays what it dispatches on
    writePin(deps, run);
    await claimRun(deps, run);
    return run;
  };
  // the run this one takes over must be free to close before anything is created, and stay so until its pointer
  // is written: its admission lock is held from the check to the pointer, so no dispatch gets in between and
  // leaves the new run open beside it (PR #50). It is the only lock taken first: the new run's are uncontended.
  const from = i.from === undefined ? null : findRun(i.from);
  const run = from
    ? await withFileLock(runPaths(from.dir).admission, async () => {
        assertNoLiveRoles(deps, from, `cancel them or let them finish, then run_start with from: ${from.id}`);
        const opened = await open();
        writeSuperseded(deps, from, opened.id);
        return opened;
      })
    : await open();
  const superseded = from ? await supersededHints(from, run.id) : {};
  // a failed state.md refresh never fails the start: the run exists and is usable, so a retry would orphan it
  const { hints } = await refreshState(run);
  hints.push(...(superseded.hints ?? []));
  // spec 1.1 §10: the milestone loop, so the orchestrator starts on the protocol
  return { run: run.id, dir: run.dir, protocol: protocolView(run, []), ...(hints.length ? { hints } : {}) };
}

export function writeRunFile(i: { run: string; path: string; content: string }): {
  path: string;
  bytes: number;
} {
  const run = findRun(i.run);
  const file = runFile(run, i.path, "write");
  // spec 1.5 "Lane editing": a lane's header values are checked when it is written, not first at preflight
  const lane = /^lanes\/([^/]+)\.md$/.exec(relative(run.dir, file).split(sep).join("/"));
  if (lane) assertLaneValues(i.content, `lanes/${lane[1]}.md`);
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

/**
 * `set_next`: state.md's new text, and, as every tool gives them, `hints`: `state.md not refreshed: <message>`
 * when git fails, with `state` null (the note is kept in state.json either way).
 */
export async function setNext(i: {
  run: string;
  next: string;
}): Promise<{ state: string | null; hints?: string[] }> {
  const { text, hints } = await refreshState(findRun(i.run), { next: i.next });
  return { state: text ?? null, ...(hints.length ? { hints } : {}) };
}

const CAP_LINES = 250;
const CAP_CHARS = 20_000;

function capReply(reply: string, path: string): string {
  const lines = reply.split("\n");
  const head = lines.length > CAP_LINES ? lines.slice(0, CAP_LINES).join("\n") : reply;
  if (head === reply && reply.length <= CAP_CHARS) return reply;
  return `${head.slice(0, CAP_CHARS)}\n[capped: the full reply is ${path}]`;
}

/** Whether `text` names `token` (a role name or lane id) as a whole word, a full stop after it allowed. */
export function names(text: string, token: string): boolean {
  const t = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])${t}(?![\\w-]|\\.\\w)`).test(text);
}

/**
 * Plan 22: state.md's Next never outlives the step it names. When it names a role whose record `result` returns
 * (by its name or its lane), it moves on to the protocol's next step. A refresh that fails comes back as hints.
 */
async function advanceNext(run: Run, record: RunRecord): Promise<string[]> {
  const stale = (next: string) =>
    names(next, record.name) || (record.lane !== null && names(next, record.lane));
  if (!stale(readNotes(run).next)) return [];
  const { hints } = await refreshState(run, (n) =>
    stale(n.next)
      ? { next: `after ${record.name} (${record.status}): ${protocolNext(run, n.parked ?? [])}` }
      : {},
  );
  return hints;
}

/**
 * A role's latest dispatch: its record once finished, its capped reply and its hints. Spec §3.7: reading a
 * finished record marks it read, with the collect lease (each record is marked read once, whoever reads it);
 * an earlier record of the same name still unread (a usage limit its stand-in replaced) is marked read with it,
 * and its hints come first.
 */
export async function result(
  deps: Deps,
  i: { run: string; name: string },
): Promise<{
  name: string;
  state: DispatchState | null;
  record: RunRecord | null;
  reply: string;
  replyPath: string | null;
  hints: string[];
}> {
  const run = findRun(i.run);
  assertId("role name", i.name);
  const d = latestDispatch(run, i.name);
  if (!d)
    throw new CatherdError("E_RUN_NOT_FOUND", `${i.name} was never dispatched in this run`, {
      fix: "status(run) lists the roles",
    });
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  const record = records.get(d.admit.dispatchId) ?? null;
  const hints: string[] = [];
  for (const x of listDispatches(run).filter((x) => x.admit.name === i.name)) {
    const r = records.get(x.admit.dispatchId);
    if (!r || !awaitsCollect(x.dir) || !(await tryCollect(x.dir))) continue;
    // read at once: the lease ends as the record goes out
    endCollect(x.dir);
    if (x.admit.dispatchId !== d.admit.dispatchId) hints.push(...recordHints(run, x, r));
  }
  if (record) for (const h of recordHints(run, d, record)) if (!hints.includes(h)) hints.push(h);
  if (record) for (const h of await advanceNext(run, record)) if (!hints.includes(h)) hints.push(h);
  const reply = dispatchPaths(d.dir).reply;
  const text = existsSync(reply) ? readFileSync(reply, "utf8") : "";
  return {
    name: i.name,
    state: record ? "finished" : dispatchState(d, deps.now()),
    record,
    reply: capReply(text, relative(run.dir, reply)),
    replyPath: relative(run.dir, reply),
    hints,
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
    lane?: string;
    /** plan 23: a native verifier's first reply line, so a VERDICT: BLOCKED: environment is told from a FAIL */
    verdict?: string;
    /** plan 23: the STATUS word of the subagent's reply */
    replyStatus?: NonNullable<AgentRun["replyStatus"]>;
  },
): AgentRun {
  const run = findRun(i.run);
  assertId("role name", i.name);
  if (i.lane !== undefined) assertId("lane", i.lane);
  if (parseRung(i.rung).backend !== "claude")
    throw new CatherdError("E_ADMIT_RUNG", `${i.rung} is not a native Claude rung`, {
      fix: "record_agent_run is for Agent subagents; dispatch records every other run itself",
    });
  assertNativeHost(i.rung, deps.host.conflict ? "unknown" : deps.host.host);
  const row: AgentRun = {
    at: new Date(deps.now()).toISOString(),
    name: i.name,
    role: i.role,
    rung: i.rung,
    agent: deps.profiles.agentFor(run.meta.repo, i.role, i.rung),
    totalTokens: i.totalTokens,
    costUsd: i.costUsd ?? null,
    secs: i.durationMs === undefined ? null : Math.round(i.durationMs / 1000),
    status: i.status ?? "ok",
    lane: i.lane ?? null,
    ...(i.verdict ? { verdict: i.verdict.trim().split("\n")[0] } : {}),
    ...(i.replyStatus ? { replyStatus: i.replyStatus } : {}),
  };
  appendAgentRun(run, row);
  return row;
}

/** The git toplevel of `repo`, any path inside it; refused outside a repository. */
async function repoTop(repo: string): Promise<string> {
  const top = await gitToplevel(repo);
  if (!top)
    throw new CatherdError("E_IO_PATH", `${repo} is not inside a git repository`, {
      fix: "pass the path of the repository",
    });
  return top;
}

/** What past runs of the repo learned; `repo` may be any path inside it. */
export async function readKnowledge(repo: string): Promise<string> {
  const file = await knowledgeFor(await repoTop(repo));
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return text.trim() ? text : "catherd: no knowledge recorded yet for this repo";
}

/** Where the repo's knowledge.md is (it may not exist yet); `repo` may be any path inside it. */
export async function knowledgePath(repo: string): Promise<{ repo: string; path: string }> {
  const top = await repoTop(repo);
  return { repo: top, path: await knowledgeFor(top) };
}

/** The repo's knowledge.md as its lines, none when it is missing or blank; `repo` may be any path inside it. */
export async function knowledgeLines(repo: string): Promise<{ repo: string; path: string; lines: string[] }> {
  const at = await knowledgePath(repo);
  const text = existsSync(at.path) ? readFileSync(at.path, "utf8") : "";
  return { ...at, lines: text.split("\n").filter((l) => l.trim()) };
}

/** The source a line added by hand carries, where a landing puts its run's title and milestone. */
const BY_HAND = "by hand";

/** Appends one line of the user's own to the repo's knowledge.md, as `land`'s `learned` does; returns it. */
export async function addKnowledge(repo: string, text: string, now: Date = new Date()): Promise<string> {
  const top = await repoTop(repo);
  if (!text.trim())
    throw new CatherdError("E_INPUT_INVALID", "the knowledge line is empty", {
      fix: 'pass one line of text, e.g. catherd knowledge add "the targeted test is bun test <file>"',
    });
  return appendKnowledge(top, now, BY_HAND, text);
}
