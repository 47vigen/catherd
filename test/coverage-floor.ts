/**
 * Spec §11's coverage floor, over `src/` as a whole. `bun test`'s own `coverageThreshold` holds every file
 * to the floor on its own (a CLI entry the unit tests only half reach fails it), so CI writes an lcov report
 * and this script checks the totals, weighted by lines and functions. Not a `bun test` file.
 *
 *   bun test --coverage --coverage-reporter=text --coverage-reporter=lcov && bun test/coverage-floor.ts
 */
import { readFileSync } from "node:fs";

// Measured at 92.9 % of functions and 93.8 % of lines over src/ (plans 1–7); the floor leaves room for small
// drops. Should a change make it fail, set each value to the measured one minus two points, rounded down.
const FLOOR = { lines: 0.88, functions: 0.85 };

const file = process.argv[2] ?? "coverage/lcov.info";
const t = { lf: 0, lh: 0, fnf: 0, fnh: 0 };
let inSrc = false;
for (const line of readFileSync(file, "utf8").split("\n")) {
  const at = line.indexOf(":");
  const key = line.slice(0, at);
  const value = line.slice(at + 1);
  if (key === "SF") inSrc = value.startsWith("src/");
  else if (inSrc && key === "LF") t.lf += Number(value);
  else if (inSrc && key === "LH") t.lh += Number(value);
  else if (inSrc && key === "FNF") t.fnf += Number(value);
  else if (inSrc && key === "FNH") t.fnh += Number(value);
}
const lines = t.lf ? t.lh / t.lf : 0;
const functions = t.fnf ? t.fnh / t.fnf : 0;
const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
console.log(`src/: ${pct(functions)} of functions, ${pct(lines)} of lines`);
if (lines < FLOOR.lines || functions < FLOOR.functions) {
  console.error(`below the floor: ${pct(FLOOR.functions)} of functions, ${pct(FLOOR.lines)} of lines`);
  process.exit(1);
}
