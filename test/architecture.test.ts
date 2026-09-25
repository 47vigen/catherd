import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");
const RANK: Record<string, number> = { domain: 0, infra: 1, adapters: 2, services: 3, entry: 4 };
/** 0.x modules; `cli.ts` is the entry point, which the new layers never import, so it is not listed. */
const LEGACY = new Set([
  "core",
  "mcp",
  "routing",
  "profile",
  "tui",
  "paths.ts",
  "files.ts",
  "version.ts",
  "types.ts",
]);
/** 0.x behind the 1.0 ports until plans 4 and 5 replace it; only the entry layer may wire it in. */
const BRIDGE = "bridge";
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
    if (LEGACY.has(top)) violations.push(`${file} imports 0.x ${target}`);
    else if (top === BRIDGE && from !== "entry") violations.push(`${file} (${from}) imports the 0.x bridge`);
    else if (top in RANK && (RANK[top] as number) > (RANK[from] as number))
      violations.push(`${file} (${from}) imports upward ${target} (${top})`);
  }
  return violations;
}

describe("architecture", () => {
  it("flags 0.x and upward imports in every import form", () => {
    const flagged = (line: string) => violationsIn("infra/x.ts", line).length;
    expect(flagged(`import "../core/x.ts";`)).toBe(1);
    expect(flagged(`import '../mcp/y.ts'`)).toBe(1);
    expect(flagged(`import { a } from "../core/x.ts";`)).toBe(1);
    expect(flagged(`import {\n  a,\n  b,\n} from "../routing/r.ts";`)).toBe(1);
    expect(flagged(`export * from "../tui/t.tsx";`)).toBe(1);
    expect(flagged(`const m = await import("../profile/p.ts");`)).toBe(1);
    for (const root of ["paths", "files", "version", "types"])
      expect(flagged(`import { x } from "../${root}.ts";`)).toBe(1);
    expect(flagged(`import { x } from "../adapters/a.ts";`)).toBe(1);
    expect(flagged(`import "../entry/e.ts";`)).toBe(1);
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

  it("lets only the entry layer import the 0.x bridge", () => {
    expect(violationsIn("services/x.ts", `import { v0Routing } from "../bridge/v0.ts";`)).toHaveLength(1);
    expect(violationsIn("domain/x.ts", `import "../bridge/v0.ts";`)).toHaveLength(1);
    expect(violationsIn("entry/mcp/server.ts", `import { v0Routing } from "../../bridge/v0.ts";`)).toEqual(
      [],
    );
  });

  it("new layers import only downward and never from 0.x modules", () => {
    const violations = layerFiles().flatMap((file) =>
      violationsIn(file, readFileSync(join(SRC, file), "utf8")),
    );
    expect(violations).toEqual([]);
  });
});
