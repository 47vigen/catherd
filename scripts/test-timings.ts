// Writes test/timings.json (file -> seconds) from a junit report, for scripts/test-shard.ts:
//   bun test --reporter=junit --reporter-outfile=junit.xml && bun scripts/test-timings.ts junit.xml
import { readFileSync, writeFileSync } from "node:fs";

const [input, out = "test/timings.json"] = Bun.argv.slice(2);
if (!input) {
  console.error("usage: bun scripts/test-timings.ts <junit.xml> [out.json]");
  process.exit(2);
}

// a file's own suite is the one named after the file; its nested describes carry other names
const timings: Record<string, number> = {};
for (const m of readFileSync(input, "utf8").matchAll(
  /<testsuite name="([^"]+)" file="([^"]+)"[^>]* time="([^"]+)"/g,
)) {
  if (m[1] === m[2]) timings[m[2] as string] = Math.round(Number(m[3]) * 100) / 100;
}
if (Object.keys(timings).length === 0) {
  console.error(`no per-file suites in ${input}`);
  process.exit(1);
}
const sorted = Object.fromEntries(Object.entries(timings).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(out, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`${Object.keys(sorted).length} files -> ${out}`);
