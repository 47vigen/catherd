import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CatherdError } from "../domain/errors.ts";
import { ID_PATTERN } from "../domain/ids.ts";
import { FindingSchema, RUN_UNIT, type RunEvent } from "../domain/run-events.ts";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { git } from "../infra/git.ts";
import { readEvents } from "./run-events-store.ts";
import { readRecords, type Run, runPaths } from "./run-store.ts";

/*
 * What the panel's drawer reads from a run's folder. Every name a caller sends is matched against what the run
 * itself knows (its events, its records, a fixed list of file names) and never joined into a path unchecked.
 */

const TEXT_CAP = 512 * 1024;
const LOG_CAP = 64 * 1024;
const DIFF_CAP = 1024 * 1024;

const invalid = (message: string): CatherdError => new CatherdError("E_INPUT_INVALID", message);
const notFound = (file: string): CatherdError =>
  new CatherdError("E_RUN_NOT_FOUND", `no such file in the run: ${file}`);

/** The first `max` bytes of a file (the last `max` with `tail`), or null when it cannot be read. */
function readCapped(file: string, max: number, tail = false): { text: string; cut: boolean } | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    let got = 0;
    const from = tail ? st.size - len : 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, from + got);
      if (n === 0) break;
      got += n;
    }
    const cut = st.size > max;
    let start = 0;
    let end = got;
    if (cut && got > 0) {
      if (tail) {
        while (start < Math.min(3, got) && (buf[start]! & 0xc0) === 0x80) start++;
      } else {
        let i = got - 1;
        while (i > 0 && (buf[i]! & 0xc0) === 0x80) i--;
        const lead = buf[i]!;
        const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
        if (length > got - i) end = i;
      }
    }
    return { text: buf.subarray(start, end).toString("utf8"), cut };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export const DispatchDetailSchema = z.object({
  dispatchId: z.string(),
  name: z.string(),
  role: z.string(),
  unit: z.string(),
  lane: z.string().nullable(),
  rung: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.string().nullable(),
  replyStatus: z.string().nullable(),
  why: z.string().nullable(),
  record: z
    .object({
      attempt: z.number().int(),
      failoverFrom: z.string().nullable(),
      secs: z.number(),
      tokens: z.object({
        input: z.number(),
        cached: z.number(),
        cacheWrite: z.number().optional(),
        output: z.number(),
      }),
      costUsd: z.number().nullable(),
      exitCode: z.number().int().nullable(),
      access: z.string(),
      isolated: z.boolean(),
      cliVersion: z.string().nullable(),
    })
    .nullable(),
  brief: z.string().nullable(),
  reply: z.string().nullable(),
  stderr: z.string().nullable(),
  findings: z.array(FindingSchema),
  aLines: z.array(z.object({ id: z.string(), pass: z.boolean(), text: z.string() })),
  truncated: z.array(z.enum(["brief", "reply", "stderr"])),
});
export type DispatchDetail = z.infer<typeof DispatchDetailSchema>;

type Ev<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;

/** What the run knows of one dispatch: its events and its record. Unknown ids are refused. */
function known(run: Run, dispatchId: string) {
  if (!ID_PATTERN.test(dispatchId)) throw invalid(`bad dispatch id "${dispatchId}"`);
  const events = readEvents(run);
  const started = events.find(
    (e): e is Ev<"dispatch.started"> => e.type === "dispatch.started" && e.dispatchId === dispatchId,
  );
  const ended = events.find(
    (e): e is Ev<"dispatch.ended"> => e.type === "dispatch.ended" && e.dispatchId === dispatchId,
  );
  const record = readRecords(run).records.find((r) => r.dispatchId === dispatchId);
  const name = started?.name ?? ended?.name ?? record?.name;
  if (!name || !ID_PATTERN.test(name) || name.includes(".."))
    throw invalid(`no dispatch "${dispatchId}" in this run`);
  return { events, started, ended, record, name };
}

/** `roles/<name>/<id>`; the name comes from the run's events, else its records. */
export function dispatchDir(run: Run, dispatchId: string): string {
  return join(runPaths(run.dir).roles, known(run, dispatchId).name, dispatchId);
}

const A_LINE = /^\s*[-*]?\s*(A\d+)\s+(PASS|FAIL)\b\s*(.*)$/gm;

export function dispatchDetail(run: Run, dispatchId: string): DispatchDetail {
  const { started, ended, record, name } = known(run, dispatchId);
  const dir = join(runPaths(run.dir).roles, name, dispatchId);
  const p = dispatchPaths(dir);
  const truncated: DispatchDetail["truncated"] = [];
  const text = (key: "brief" | "reply" | "stderr", file: string): string | null => {
    const r = readCapped(file, TEXT_CAP);
    if (r?.cut) truncated.push(key);
    return r?.text ?? null;
  };
  const brief = text("brief", p.brief);
  const reply = text("reply", p.reply);
  const stderr = text("stderr", p.stderr);

  const role = started?.role ?? record?.role ?? "";
  const lane = started ? started.lane : (record?.lane ?? null);
  const startedAt = started?.at ?? record?.startedAt ?? "";
  return {
    dispatchId,
    name,
    role,
    unit: started?.unit ?? record?.lane ?? RUN_UNIT,
    lane,
    rung: started?.rung ?? record?.rung ?? "",
    startedAt,
    endedAt: ended?.at ?? record?.endedAt ?? null,
    status: ended?.status ?? record?.status ?? null,
    replyStatus: ended ? ended.replyStatus : (record?.replyStatus ?? null),
    why: ended?.why ?? record?.replyWhy ?? null,
    record: record
      ? {
          attempt: record.attempt,
          failoverFrom: record.failoverFrom,
          secs: record.secs,
          tokens: record.tokens,
          costUsd: record.costUsd,
          exitCode: record.exitCode,
          access: record.access,
          isolated: record.isolated,
          cliVersion: record.cliVersion,
        }
      : null,
    brief,
    reply,
    stderr,
    findings: ended?.findings ?? [],
    aLines: [...(reply ?? "").matchAll(A_LINE)].map((m) => ({
      id: m[1] as string,
      pass: m[2] === "PASS",
      text: (m[3] ?? "").trim(),
    })),
    truncated,
  };
}

export const RUN_DOC_NAME = /^(plan|report|ledger)\.md$|^(lanes|digests)\/[A-Za-z0-9][\w.-]{0,127}\.md$/;

export function runDoc(run: Run, name: string): { name: string; text: string; cut: boolean } {
  if (!RUN_DOC_NAME.test(name) || name.includes("..")) throw invalid(`"${name}" is not a document of a run`);
  const r = readCapped(join(run.dir, name), TEXT_CAP);
  if (r === null) throw notFound(name);
  return { name, text: r.text, cut: r.cut };
}

export const CheckLogsSchema = z.object({
  lane: z.string(),
  name: z.string(),
  fast: z.string().nullable(),
  full: z.string().nullable(),
  exit: z.number().int().nullable(),
});
export type CheckLogs = z.infer<typeof CheckLogsSchema>;

export function checkLogs(run: Run, lane: string): CheckLogs {
  if (!ID_PATTERN.test(lane)) throw invalid(`bad lane id "${lane}"`);
  const name = `worker-${lane}`;
  const dir = join(runPaths(run.dir).scratch, name);
  const fast = readCapped(join(dir, "fast-check.log"), LOG_CAP, true)?.text ?? null;
  const full = readCapped(join(dir, "full-check.log"), LOG_CAP, true)?.text ?? null;
  if (fast === null && full === null) throw notFound(`scratch/${name}/fast-check.log`);
  return { lane, name, fast, full, exit: null };
}

const HEX = /^[0-9a-f]{7,64}$/;

/** The commits the run's own events name (a role's HEAD when it ended): the only shas a diff is served for. */
export function runShas(run: Run): string[] {
  const out = new Set<string>();
  for (const e of readEvents(run))
    if (e.type === "dispatch.ended" && e.head && HEX.test(e.head)) out.add(e.head);
  return [...out];
}

export const CommitDiffSchema = z.object({
  sha: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  paths: z.array(z.string()).nullable(),
});
export type CommitDiff = z.infer<typeof CommitDiffSchema>;

export async function commitDiff(run: Run, sha: string, o: { lane?: string } = {}): Promise<CommitDiff> {
  const q = sha.toLowerCase();
  const all = runShas(run);
  const hits = HEX.test(q) ? (all.includes(q) ? [q] : all.filter((s) => s.startsWith(q))) : [];
  if (hits.length !== 1) throw invalid(`"${sha}" is not a commit this run made`);
  const full = hits[0] as string;
  // plan 48: a run has no lanes, so a lane names no paths to narrow the diff to
  if (o.lane !== undefined) throw invalid(`no lane "${o.lane}" in this run`);
  const paths: string[] | null = null;
  const r = await git(run.meta.repo, [
    "show",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--stat",
    "--patch",
    full,
    ...(paths ? ["--", ...paths] : []),
  ]);
  if (r.kind !== "ok")
    throw new CatherdError(
      "E_IO_UNEXPECTED",
      `git show ${full.slice(0, 7)} ${r.kind === "timed-out" ? "timed out" : "failed"}`,
    );
  const bytes = Buffer.from(r.out);
  const truncated = bytes.length > DIFF_CAP;
  return {
    sha: full,
    text: truncated ? bytes.subarray(0, DIFF_CAP).toString("utf8") : r.out,
    truncated,
    paths,
  };
}
