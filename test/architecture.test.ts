import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");
const RANK: Record<string, number> = { domain: 0, infra: 1, adapters: 2, services: 3, entry: 4 };
/** `… from "x"`, `import("x")` and the side-effect form `import "x"`. */
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g;

function layerFiles(): string[] {
  const files: string[] = [];
  for (const layer of Object.keys(RANK)) {
    for (const f of new Bun.Glob(`${layer}/**/*.{ts,tsx}`).scanSync({ cwd: SRC })) files.push(f);
  }
  return files;
}

/** The layering violations in `text`, the source of `file` (a path relative to src/). */
function violationsIn(file: string, text: string): string[] {
  const violations: string[] = [];
  const from = file.split("/")[0] as string;
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec?.startsWith(".")) continue;
    const target = relative(SRC, resolve(dirname(join(SRC, file)), spec));
    const top = target.split("/")[0] as string;
    if (top in RANK && (RANK[top] as number) > (RANK[from] as number))
      violations.push(`${file} (${from}) imports upward ${target} (${top})`);
  }
  return violations;
}

describe("architecture", () => {
  it("flags upward imports in every import form", () => {
    const flagged = (line: string) => violationsIn("infra/x.ts", line).length;
    expect(flagged(`import "../services/x.ts";`)).toBe(1);
    expect(flagged(`import '../entry/mcp/y.ts'`)).toBe(1);
    expect(flagged(`import { a } from "../adapters/x.ts";`)).toBe(1);
    expect(flagged(`import {\n  a,\n  b,\n} from "../services/r.ts";`)).toBe(1);
    expect(flagged(`export * from "../entry/tui/t.tsx";`)).toBe(1);
    expect(flagged(`const m = await import("../services/p.ts");`)).toBe(1);
    expect(flagged(`import { x } from "./paths.ts";`)).toBe(0);
  });

  it("allows downward, same-layer, package and cli.ts imports", () => {
    const flagged = (line: string) => violationsIn("adapters/codex/x.ts", line).length;
    expect(flagged(`import { a } from "../../infra/paths.ts";`)).toBe(0);
    expect(flagged(`import { a } from "../../domain/ids.ts";`)).toBe(0);
    expect(flagged(`import { a } from "../contract.ts";`)).toBe(0);
    expect(flagged(`import { z } from "zod";`)).toBe(0);
    expect(flagged(`import "node:fs";`)).toBe(0);
    expect(flagged(`import { main } from "../../cli.ts";`)).toBe(0);
  });

  it("src holds only the five layers and cli.ts", () => {
    expect(readdirSync(SRC).sort()).toEqual([...Object.keys(RANK), "cli.ts"].sort());
  });

  it("every layer imports only downward", () => {
    const violations = layerFiles().flatMap((file) =>
      violationsIn(file, readFileSync(join(SRC, file), "utf8")),
    );
    expect(violations).toEqual([]);
  });
});
