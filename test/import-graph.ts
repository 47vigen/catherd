import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const SRC = resolve(import.meta.dir, "../src");
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** Every file and package `entry` reaches through static and dynamic imports (paths relative to src/). */
export function importGraph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = (m[1] ?? m[2] ?? m[3]) as string;
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  }
  return { files: [...files].map((f) => relative(SRC, f)), packages: [...packages] };
}
