import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adapterFor } from "../adapters/registry.ts";
import { CatherdError } from "../domain/errors.ts";
import { ID_PATTERN, tryParseRung } from "../domain/ids.ts";
import { db, ensureRunRow, insertMessage, storeOnFile } from "../infra/db.ts";
import { withFileLockSync } from "../infra/filelock.ts";
import { appendPrivate } from "../infra/store.ts";
import { readThread, roleDir } from "./dispatches.ts";
import { replayRun } from "./run-events-store.ts";
import { findRun, type Run } from "./run-store.ts";

/**
 * Plan 45: the team channel, a run's roles telling each other what they changed. The tool contract (send, read,
 * wait; `auto` delivery, small paged reads, a wait with a timeout, the opencode `delivery: "steer"` prompt) is
 * ported from T3 Code's thread tools (MIT, github.com/pingdotgg/t3code, THIRD_PARTY_NOTICES.md); not synced.
 */
export interface TeamMessage {
  n: number;
  at: string;
  from: string;
  to: string;
  text: string;
}

export const TEAM_FILE = "team.jsonl";

const MAX_TEXT = 2_000;
const FOR_BRIEF = 10;
const BRIEF_CHARS = 500;

const teamFile = (run: Run): string => join(run.dir, TEAM_FILE);

const invalid = (message: string, fix: string): CatherdError =>
  new CatherdError("E_INPUT_INVALID", message, { fix });

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

const clamp = (v: number | undefined, lo: number, hi: number, d: number): number =>
  Math.min(hi, Math.max(lo, Math.trunc(v ?? d)));

/** The run's messages, oldest first: `messages` rows (plan 46), or an earlier build's team.jsonl, torn lines skipped. */
export function teamMessages(run: Run): TeamMessage[] {
  if (!storeOnFile(run, teamFile(run), "messages"))
    return db()
      .query('SELECT n, at, sender AS "from", target AS "to", text FROM messages WHERE run_id = ? ORDER BY n')
      .all(run.id) as TeamMessage[];
  let text: string;
  try {
    text = readFileSync(teamFile(run), "utf8");
  } catch {
    return [];
  }
  const out: TeamMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as TeamMessage;
      if (typeof m.n === "number" && typeof m.text === "string") out.push(m);
    } catch {}
  }
  return out;
}

/** Only the architect and the owner steer a running turn (owner decision, CooperBench): a lane's message is queued. */
const steers = (from: string): boolean =>
  from === "owner" || from === "architect" || from.startsWith("architect-");

async function steerVia(backend: string, thread: string, text: string): Promise<boolean> {
  try {
    return (await adapterFor(backend)?.steer?.(thread, text)) ?? false;
  } catch {
    return false;
  }
}

/** Plan 47: a message is a `notice` (what changed) or a `question`; `queue` never steers, `auto` steers where it can. */
export const MESSAGE_KINDS = ["notice", "question"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export const SEND_MODES = ["auto", "queue", "steer"] as const;
export type SendMode = (typeof SEND_MODES)[number];

export async function teamSend(
  i: { run: string; from: string; to: string; text: string; kind?: MessageKind; mode?: SendMode },
  o: { steer?: (backend: string, thread: string, text: string) => Promise<boolean> } = {},
): Promise<{ n: number; delivery: "steered" | "queued" }> {
  const text = i.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  if (!text) throw invalid("a team message needs a text", "say what you changed: file, what, why");
  if (i.to !== "all" && (!ID_PATTERN.test(i.to) || i.to.includes("..")))
    throw invalid(
      `"${i.to}" is no lane, role or dispatch`,
      "send to a lane (M1.L2), a role (architect) or all",
    );
  const run = findRun(i.run);
  const file = teamFile(run);
  const n = withFileLockSync(file, () => {
    const n = (teamMessages(run).at(-1)?.n ?? 0) + 1;
    const m: TeamMessage = { n, at: new Date().toISOString(), from: i.from, to: i.to, text };
    if (storeOnFile(run, file, "messages")) appendPrivate(file, `${JSON.stringify(m)}\n`);
    else {
      const d = db();
      d.transaction(() => {
        ensureRunRow(d, run);
        insertMessage(d, run.id, { ...m, ...(i.kind ? { kind: i.kind } : {}) });
      }).immediate();
    }
    return n;
  });
  if (i.mode === "queue" || !steers(i.from)) return { n, delivery: "queued" };
  const state = replayRun(run);
  const live = Object.values(state.dispatches).filter((x) => x.ended === null);
  // a lane while it runs (2.0), or on an architect run a dispatch by its name (a task, plan 47)
  const d =
    state.lanes[i.to]?.status === "running"
      ? live.find((x) => x.lane === i.to)
      : state.arch
        ? live.find((x) => x.name === i.to)
        : undefined;
  const thread = d && (readThread(join(roleDir(run, d.name), d.dispatchId)) ?? d.thread);
  const backend = d && tryParseRung(d.rung)?.backend;
  if (!thread || !backend) return { n, delivery: "queued" };
  const ok = await (o.steer ?? steerVia)(backend, thread, `${i.from} (catherd team #${n}): ${text}`);
  if (ok && !existsSync(file))
    db()
      .query("UPDATE messages SET mode = 'steer', delivered_at = ? WHERE run_id = ? AND n = ?")
      .run(new Date().toISOString(), run.id, n);
  return { n, delivery: ok ? "steered" : "queued" };
}

export function teamRead(i: {
  run: string;
  from?: string;
  since?: number;
  limit?: number;
  maxChars?: number;
}): {
  messages: TeamMessage[];
  next: number | null;
} {
  const limit = clamp(i.limit, 1, 20, 10);
  const maxChars = clamp(i.maxChars, 1, 2_000, 500);
  const after = teamMessages(findRun(i.run)).filter(
    (m) => m.n > (i.since ?? 0) && (i.from === undefined || m.from === i.from),
  );
  const messages = after.slice(0, limit).map((m) => ({ ...m, text: cut(m.text, maxChars) }));
  return { messages, next: after.length > limit ? (messages.at(-1)?.n ?? null) : null };
}

export async function teamWait(
  i: { run: string; lane: string; timeoutMs?: number; since?: number },
  o: { pollMs?: number } = {},
): Promise<{ lane: string; status: string; timedOut: boolean; posted: TeamMessage[] }> {
  const run = findRun(i.run);
  const timeoutMs = clamp(i.timeoutMs, 0, 300_000, 60_000);
  const since = i.since ?? teamMessages(run).at(-1)?.n ?? 0;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lane = replayRun(run).lanes[i.lane];
    if (!lane) throw invalid(`run ${run.id} has no lane ${i.lane}`, "wait on a lane of your run, like M1.L2");
    const posted = teamMessages(run).filter((m) => m.n > since && m.from.endsWith(`-${i.lane}`));
    if (lane.status !== "running" || posted.length > 0)
      return { lane: i.lane, status: lane.status, timedOut: false, posted };
    if (Date.now() >= deadline) return { lane: i.lane, status: lane.status, timedOut: true, posted };
    await Bun.sleep(o.pollMs ?? 1_000);
  }
}

/** The number of the run's last message, 0 when there is none: the watermark a rendered brief records. */
export const teamLast = (run: Run): number => teamMessages(run).at(-1)?.n ?? 0;

/**
 * The last messages sent to this dispatch (its name, unit, role or all) by others, after message `seen`, or after
 * `since` when no watermark was recorded: brief lines.
 */
export function teamFor(
  run: Run,
  d: { name: string; unit: string; role: string; since: string | null; seen?: number },
): string[] {
  const after = (m: TeamMessage): boolean =>
    d.seen !== undefined ? m.n > d.seen : d.since === null || m.at > d.since;
  return teamMessages(run)
    .filter((m) => m.from !== d.name && [d.name, d.unit, d.role, "all"].includes(m.to) && after(m))
    .slice(-FOR_BRIEF)
    .map((m) => `- #${m.n} ${m.from} → ${m.to}: ${cut(m.text, BRIEF_CHARS)}`);
}
