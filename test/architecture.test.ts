import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");
const RANK: Record<string, number> = { domain: 0, infra: 1, adapters: 2, services: 3, entry: 4 };
const LEGACY = new Set(["core", "mcp", "routing", "profile", "tui", "types.ts"]);
const IMPORT = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function layerFiles(): string[] {
  const files: string[] = [];
  for (const layer of Object.keys(RANK)) {
    for (const f of new Bun.Glob(`${layer}/**/*.{ts,tsx}`).scanSync({ cwd: SRC })) files.push(f);
  }
  return files;
}

describe("architecture", () => {
  it("new layers import only downward and never from 0.x modules", () => {
    const violations: string[] = [];
    for (const file of layerFiles()) {
      const from = file.split("/")[0] as string;
      const text = readFileSync(join(SRC, file), "utf8");
      for (const m of text.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2];
        if (!spec?.startsWith(".")) continue;
        const target = relative(SRC, resolve(dirname(join(SRC, file)), spec));
        const top = target.split("/")[0] as string;
        if (LEGACY.has(top)) violations.push(`${file} imports 0.x ${target}`);
        else if (top in RANK && (RANK[top] as number) > (RANK[from] as number))
          violations.push(`${file} (${from}) imports upward ${target} (${top})`);
      }
    }
    expect(violations).toEqual([]);
  });
});
