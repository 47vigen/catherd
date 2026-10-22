// Runs one shard of the suite: bun scripts/test-shard.ts <index> <count>
// Every test file (the set `bun test` finds under bunfig's `root`) lands on exactly one shard, balanced by
// test/timings.json (file -> seconds; regenerate with scripts/test-timings.ts). The exit code is bun test's.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** Every `test/**\/*.test.ts`, as repo-relative paths, sorted. */
export function listTests(root = ROOT): string[] {
  const files = [...new Bun.Glob("test/**/*.test.ts").scanSync({ cwd: root })];
  return files.sort();
}

export function loadTimings(path = join(ROOT, "test/timings.json")): Record<string, number> {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Greedy longest-first: each file goes to the lightest shard. A file with no timing weighs the median. */
export function assign(files: string[], timings: Record<string, number>, count: number): string[][] {
  const known = Object.values(timings).sort((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] ?? 1;
  const weight = (f: string) => timings[f] ?? median;
  const shards = Array.from({ length: count }, () => ({ load: 0, files: [] as string[] }));
  for (const f of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((a, b) => (b.load < a.load ? b : a));
    lightest.load += weight(f);
    lightest.files.push(f);
  }
  return shards.map((s) => s.files.sort());
}

if (import.meta.main) {
  const index = Number(Bun.argv[2]);
  const count = Number(Bun.argv[3]);
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
    console.error("usage: bun scripts/test-shard.ts <index> <count>   (0 <= index < count)");
    process.exit(2);
  }
  const files = assign(listTests(), loadTimings(), count)[index] as string[];
  if (files.length === 0) {
    console.log(`shard ${index}/${count} has no files`);
    process.exit(0);
  }
  console.log(`shard ${index}/${count}: ${files.length} files`);
  const proc = Bun.spawn([process.execPath, "test", ...files.map((f) => `./${f}`)], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(await proc.exited);
}
