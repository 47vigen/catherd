import { isTestPath, removedTests, SKIP_LINE, type TestChanges, testChangeLines } from "../domain/mr-body.ts";
import { git } from "../infra/git.ts";
import { baseSha } from "./architect-check.ts";
import type { Run } from "./run-store.ts";
import { runTree } from "./tree-path.ts";

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

async function out(tree: string, args: string[]): Promise<string> {
  const r = await git(tree, args, 60_000);
  if (r.kind !== "ok") throw new Error(`git ${args.join(" ")} failed`);
  return r.out;
}

/**
 * Plan 54, spec D9: what the diff from `from` to `to` (the working tree when absent) did to the tests: test files
 * deleted, test cases removed, existing test files that lost lines otherwise (rewritten), and added skips.
 */
export async function testChanges(tree: string, from: string, to?: string): Promise<TestChanges> {
  const range = [from, ...(to ? [to] : [])];
  const diff = await out(tree, ["diff", "-U0", ...range]);
  const removed = removedTests(diff);
  const rewritten = lines(await out(tree, ["diff", "--numstat", "--diff-filter=M", ...range])).flatMap(
    (l) => {
      const [, minus, path] = l.split("\t");
      const n = Number(minus);
      return path && isTestPath(path) && n > 0 && !removed.some((r) => r.startsWith(`${path}: `))
        ? [`${path} (-${n} line${n === 1 ? "" : "s"})`]
        : [];
    },
  );
  return {
    deleted: lines(await out(tree, ["diff", "--name-only", "--diff-filter=D", ...range])).filter(isTestPath),
    removed,
    rewritten,
    skipped: diff
      .split("\n")
      .filter((x) => x.startsWith("+") && !x.startsWith("+++") && SKIP_LINE.test(x))
      .map((x) => x.slice(1).trim())
      .slice(0, 20),
  };
}

/** The verifier's record of the run's test changes against its base, one line each; empty when git cannot say. */
export async function testFacts(run: Run): Promise<string[]> {
  try {
    const tree = runTree(run);
    const from = await baseSha(run, tree);
    return from ? testChangeLines(await testChanges(tree, from)) : [];
  } catch {
    return [];
  }
}
