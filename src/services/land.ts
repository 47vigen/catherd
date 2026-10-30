import { join } from "node:path";
import { type ArchLand, knownIssues, oracleOverrides } from "../domain/architect-state.ts";
import { isGithub, landSubject, mrCommand, runBranch } from "../domain/branch.ts";
import { errorMessage } from "../domain/errors.ts";
import { mrBody } from "../domain/mr-body.ts";
import { describeEvent, type RunEvent, type RunEventInput } from "../domain/run-events.ts";
import { db } from "../infra/db.ts";
import { currentBranch, fetchBase, gitOrigin, gitRun } from "../infra/git.ts";
import { ensurePrivateDir, writeTextAtomic } from "../infra/store.ts";
import { ledgerTasks } from "./ledger-store.ts";
import { appendEvent, readEvents, replayRun } from "./run-events-store.ts";
import type { Run } from "./run-store.ts";
import { branchPusher } from "./run-tree.ts";
import { unreleasedOracles } from "./oracle.ts";
import { testChanges } from "./test-changes.ts";
import { runTree } from "./tree-path.ts";

type LandDone = Extract<RunEventInput, { type: "land.done" }>;

const FORGE_MS = 120_000;
const TAIL = 600;
const LS_REMOTE_MS = 60_000;
const tail = (s: string): string => s.trim().slice(-TAIL);
const lastUrl = (s: string): string | null => s.match(/https?:\/\/\S+/g)?.at(-1) ?? null;

async function cli(cwd: string, argv: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, { cwd, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill("SIGKILL"), FORGE_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, out: `${out}${err}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opens a run's MR, or updates its body when it is open already, with gh (github.com) or glab (any other host), in
 * the run's tree with catherd's own environment. Returns its URL, or null when the CLI printed none. Tests replace it.
 */
export const forge = {
  open: async (o: {
    tree: string;
    originUrl: string;
    base: string;
    branch: string;
    title: string;
    body: string;
    bodyFile: string;
  }): Promise<string | null> => {
    const gh = isGithub(o.originUrl);
    const created = gh
      ? await cli(o.tree, [
          "gh",
          "pr",
          "create",
          "--base",
          o.base,
          "--head",
          o.branch,
          "--title",
          o.title,
          "--body-file",
          o.bodyFile,
        ])
      : await cli(o.tree, [
          "glab",
          "mr",
          "create",
          "--source-branch",
          o.branch,
          "--target-branch",
          o.base,
          "--title",
          o.title,
          "--description",
          o.body,
          "--yes",
        ]);
    if (created.code === 0) return lastUrl(created.out);
    if (!/already exists/i.test(created.out)) throw new Error(tail(created.out) || `exit ${created.code}`);
    const updated = gh
      ? await cli(o.tree, ["gh", "pr", "edit", o.branch, "--body-file", o.bodyFile])
      : await cli(o.tree, ["glab", "mr", "update", o.branch, "--description", o.body]);
    if (updated.code !== 0) throw new Error(tail(updated.out) || `exit ${updated.code}`);
    return lastUrl(created.out) ?? lastUrl(updated.out);
  },
};

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

async function out(tree: string, args: string[]): Promise<string> {
  const r = await gitRun(tree, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${tail(`${r.out}${r.err}`)}`);
  return r.out;
}

/** Origin's default branch: the cached origin/HEAD, else what the remote itself says; null when neither does. */
async function originDefault(tree: string): Promise<string | null> {
  const cached = await gitRun(tree, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]);
  const name = cached.code === 0 ? cached.out.trim().replace(/^origin\//, "") : "";
  if (name) return name;
  const r = await gitRun(tree, ["ls-remote", "--symref", "origin", "HEAD"], LS_REMOTE_MS);
  return r.code === 0 ? (/^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(r.out)?.[1] ?? null) : null;
}

/** Whether `branch` exists on origin; null when the remote cannot say. */
async function onOrigin(tree: string, branch: string): Promise<boolean | null> {
  const r = await gitRun(tree, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], LS_REMOTE_MS);
  return r.code === 0 ? r.out.trim() !== "" : null;
}

/** An earlier land of this run that pushed: pushed outright, or pushed and then refused its final. */
const pushedBefore = (events: readonly RunEvent[]): boolean =>
  events.some((e) => e.type === "land.done" && (e.outcome === "pushed" || e.message.startsWith("pushed ")));

/** The shas this run meant to push to `branch`, from its `land.started` events. */
const intents = (events: readonly RunEvent[], branch: string): string[] =>
  events.flatMap((e) => (e.type === "land.started" && e.branch === branch ? [e.sha] : []));

/**
 * Whether origin's `branch` is this run's: an earlier land of the run meant to push it (a daemon died after the push,
 * before its `land.done`) and the remote tip is one of those commits or a descendant of one.
 */
async function ownBranch(tree: string, branch: string, shas: string[]): Promise<boolean> {
  if (shas.length === 0) return false;
  const fetched = await gitRun(tree, ["fetch", "-q", "origin", `refs/heads/${branch}`], LS_REMOTE_MS);
  if (fetched.code !== 0) return false;
  for (const sha of shas)
    if ((await gitRun(tree, ["merge-base", "--is-ancestor", sha, "FETCH_HEAD"])).code === 0) return true;
  return false;
}

/**
 * A green full check of this run on `sha` (spec D11), with its command and log; plan 52: one whose every failure the
 * base has too counts, with those failures.
 */
function greenFull(run: Run, sha: string): { command: string; log: string; failures: string[] } | null {
  const r = db()
    .query(
      "SELECT check_id, command, failures FROM checks WHERE run_id = ? AND scope = 'full' AND base = 0 AND ref = ? AND (exit = 0 OR verdict = 'inherited') ORDER BY id DESC LIMIT 1",
    )
    .get(run.id, sha) as { check_id: string; command: string; failures: string } | null;
  return r
    ? { command: r.command, log: `checks/${r.check_id}.log`, failures: JSON.parse(r.failures) as string[] }
    : null;
}

/** A verifier PASS whose HEAD line names `sha` (a full sha, or a prefix of at least 7). */
const verified = (events: readonly RunEvent[], sha: string): boolean =>
  events.some(
    (e) =>
      e.type === "dispatch.ended" &&
      e.verdict === "pass" &&
      !!e.head &&
      e.head.length >= 7 &&
      sha.startsWith(e.head),
  );

const WHY_EVENTS = new Set([
  "task.delegated",
  "task.cancelled",
  "check.requested",
  "ledger.changed",
  "thread.sent",
  "run.finishing",
  "land.requested",
  "findings.handled",
  "review.missed",
  "oracle.accepted",
  "merge.requested",
]);

/**
 * Plan 50, spec D11: lands the run's tree. It commits what the tree holds, pushes the run's branch (never forced, never
 * the base or origin's default branch) and opens or updates its MR. `final` also needs a green full check and a
 * verifier PASS on the pushed commit; it fetches the base first, and when base commits since the run's merge base touch
 * the run's files it merges the base, pushes, and asks for the check and the verifier again. A final land that passes
 * returns the owner's one question: merge?
 */
export async function runLand(run: Run, l: ArchLand): Promise<{ done: LandDone; question: string | null }> {
  const base = run.meta.base as string;
  const branch = runBranch(run.meta.title);
  let sha: string | null = null;
  let mr: string | null = null;
  const done = (outcome: "pushed" | "refused", message: string): LandDone => ({
    type: "land.done",
    landId: l.landId,
    final: l.final,
    outcome,
    branch,
    sha,
    mr,
    message,
  });
  const refused = (message: string) => ({ done: done("refused", message), question: null });
  try {
    const tree = runTree(run);
    const dflt = await originDefault(tree);
    if (!dflt) return refused("origin's default branch cannot be resolved: reach origin, then land again");
    if ([base, "main", "master", dflt].includes(branch))
      return refused(`${branch} is a protected branch: catherd never pushes it`);
    const on = await currentBranch(tree);
    if (on !== branch)
      return refused(
        `the run's tree has ${on ?? "no branch"} checked out, not ${branch}: check out ${branch}`,
      );
    if ((await out(tree, ["status", "--porcelain"])).trim()) {
      await out(tree, ["add", "-A"]);
      await out(tree, ["commit", "-q", "-m", landSubject(run.meta.title)]);
    }
    sha = (await out(tree, ["rev-parse", "HEAD"])).trim();
    let moved: string | null = null;
    if (l.final) {
      if (!(await fetchBase(tree, base)))
        return refused(`fetch of origin/${base} failed: land final needs the base as it is now`);
      const mb = (await out(tree, ["merge-base", "HEAD", `origin/${base}`])).trim();
      const theirs = new Set(lines(await out(tree, ["diff", "--name-only", mb, `origin/${base}`])));
      const overlap = lines(await out(tree, ["diff", "--name-only", mb, "HEAD"])).filter((f) =>
        theirs.has(f),
      );
      if (overlap.length) {
        const merged = await gitRun(tree, ["merge", "--no-edit", "-q", `origin/${base}`]);
        if (merged.code !== 0) {
          await gitRun(tree, ["merge", "--abort"]);
          return refused(
            `the base moved and does not merge cleanly into ${overlap.join(", ")}: ${tail(`${merged.out}${merged.err}`)}`,
          );
        }
        sha = (await out(tree, ["rev-parse", "HEAD"])).trim();
        moved = `the base moved under ${overlap.join(", ")}: merged origin/${base} as ${sha.slice(0, 12)}`;
      }
    }
    if (!pushedBefore(readEvents(run))) {
      const there = await onOrigin(tree, branch);
      if (there === null) return refused("origin cannot be reached: reach origin, then land again");
      if (there && !(await ownBranch(tree, branch, intents(readEvents(run), branch))))
        return refused(
          `branch ${branch} already exists on origin and is not this run's: rename the run, then land again`,
        );
    }
    // before the push: a daemon that dies after it still finds its own branch on origin at the retry
    await appendEvent(run, { type: "land.started", landId: l.landId, branch, sha });
    await branchPusher.push(tree, branch, sha);
    const mb = (await out(tree, ["merge-base", "HEAD", `origin/${base}`])).trim();
    const events = readEvents(run);
    const tasks = ledgerTasks(run);
    const proof = greenFull(run, sha);
    // an inherited line the architect logged as a known issue too is listed once
    const arch = replayRun(run).arch;
    const logged = knownIssues(arch, tasks);
    const issues = [
      ...logged,
      ...(proof?.failures ?? [])
        .filter((f) => !logged.some((k) => k.includes(f)))
        .map((f) => `inherited from the base (\`${proof?.command}\`): ${f}`),
    ];
    const body = mrBody({
      title: run.meta.title,
      aLines: run.meta.aLines,
      done: tasks.filter((t) => t.state === "done").map((t) => `${t.id} ${t.goal}`),
      proof: proof ? { command: proof.command, log: proof.log, sha, inherited: proof.failures.length } : null,
      audit: events
        // plan 53: a fast check catherd asked for is the daemon's, not a decision of the run's
        .filter(
          (e) =>
            (WHY_EVENTS.has(e.type) &&
              !((e.type === "check.requested" || e.type === "merge.requested") && e.by === "catherd")) ||
            (e.type === "question.parked" && e.why),
        )
        .map((e) => describeEvent(e)),
      knownIssues: issues,
      tests: await testChanges(tree, mb, "HEAD"),
      oracle: oracleOverrides(arch),
    });
    ensurePrivateDir(join(run.dir, "land"));
    const bodyFile = join(run.dir, "land", "mr.md");
    writeTextAtomic(bodyFile, body);
    const originUrl = (await gitOrigin(tree)) ?? "";
    let note = "";
    try {
      mr = await forge.open({ tree, originUrl, base, branch, title: run.meta.title, body, bodyFile });
    } catch (e) {
      note = `; the MR was not opened (${errorMessage(e)}): open it with ${mrCommand({ originUrl, base, branch, body: bodyFile })}`;
    }
    const pushed = `pushed ${branch} at ${sha.slice(0, 12)}${mr ? `, MR ${mr}` : ""}${note}`;
    if (!l.final) return { done: done("pushed", pushed), question: null };
    if (moved)
      return {
        done: done("refused", `${pushed}; ${moved}: run check full and the verifier on it, then land final`),
        question: null,
      };
    const missing = [
      ...(proof
        ? []
        : [`a green full check on ${sha.slice(0, 12)} (check scope: full on the committed tree)`]),
      ...(verified(events, sha) ? [] : [`a verifier PASS whose HEAD line names ${sha.slice(0, 12)}`]),
      ...(await unreleasedOracles(tree, arch)),
    ];
    if (missing.length)
      return {
        done: done("refused", `${pushed}; land final needs ${missing.join(" and ")}`),
        question: null,
      };
    return {
      done: done("pushed", pushed),
      question: [
        `Merge ${mr ?? branch} into ${base}? Run ${run.id}: ${run.meta.title}. The full check and the verifier passed on ${sha.slice(0, 12)}. Recommendation: merge.`,
        "- merge",
        "- not yet",
      ].join("\n"),
    };
  } catch (e) {
    return refused(errorMessage(e));
  }
}
