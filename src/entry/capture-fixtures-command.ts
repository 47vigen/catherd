import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { assetPath } from "../infra/assets.ts";
import { CAPTURE_BACKENDS, type Captured, captureFixtures } from "../services/capture.ts";
import { exitCodeOf, mark, printError } from "./cli-kit.ts";

/**
 * Spec §11.8: fixtures go to the catherd checkout's test/fixtures/adapters, next to the contract fixtures
 * they feed, wherever the command runs; null for an installed package, which has no tests to feed.
 */
export function defaultOut(): string | null {
  const dir = assetPath("test/fixtures/adapters");
  return existsSync(dir) ? dir : null;
}

export function formatCaptured(r: Captured): string {
  return r.status === "captured"
    ? `${mark("ok")} ${r.backend} ${r.cliVersion} ${r.name} → ${r.dir}/${r.name}.jsonl (exit ${r.exitCode})`
    : `${mark("skip")} ${r.backend} ${r.name} skipped: ${r.reason}`;
}

export const captureFixturesCommand = defineCommand({
  meta: {
    name: "capture-fixtures",
    description: "Record one cheap real run per ready backend as sanitized test fixtures",
  },
  args: {
    backend: { type: "string", description: `only this backend (${CAPTURE_BACKENDS.join(", ")})` },
    out: { type: "string", description: "fixture root (default: this checkout's test/fixtures/adapters)" },
  },
  async run({ args }) {
    const refuse = (message: string, fix: string): void => {
      const e = new CatherdError("E_INPUT_INVALID", message, { fix });
      printError(e);
      process.exitCode = exitCodeOf(e);
    };
    const out = args.out ? resolve(args.out) : defaultOut();
    if (!out)
      return refuse(
        "no --out, and this catherd is not a source checkout",
        "catherd capture-fixtures --out <dir>",
      );
    if (args.backend && !CAPTURE_BACKENDS.includes(args.backend))
      return refuse(
        `no capture cases for backend "${args.backend}"`,
        `catherd capture-fixtures --backend ${CAPTURE_BACKENDS.join("|")}`,
      );
    const results = await captureFixtures({
      outDir: out,
      backends: args.backend ? [args.backend] : undefined,
    });
    for (const r of results) console.log(formatCaptured(r));
    process.exitCode = results.some((r) => r.status === "captured") ? 0 : 1;
  },
});
