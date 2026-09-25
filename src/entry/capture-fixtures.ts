import { resolve } from "node:path";
import { defineCommand } from "citty";
import { CAPTURE_BACKENDS, type Captured, captureFixtures } from "../services/capture.ts";

export function formatCaptured(r: Captured): string {
  return r.status === "captured"
    ? `✓ ${r.backend} ${r.cliVersion} ${r.name} → ${r.dir}/${r.name}.jsonl (exit ${r.exitCode})`
    : `- ${r.backend} ${r.name} skipped: ${r.reason}`;
}

export const captureFixturesCommand = defineCommand({
  meta: {
    name: "capture-fixtures",
    description: "Record one cheap real run per ready backend as sanitized test fixtures",
  },
  args: {
    backend: { type: "string", description: `only this backend (${CAPTURE_BACKENDS.join(", ")})` },
    out: { type: "string", description: "fixture root", default: "test/fixtures/adapters" },
  },
  async run({ args }) {
    if (args.backend && !CAPTURE_BACKENDS.includes(args.backend)) {
      console.error(`error E_INPUT_INVALID: no capture cases for backend "${args.backend}"`);
      console.error(`fix: pass --backend ${CAPTURE_BACKENDS.join("|")}`);
      process.exitCode = 2;
      return;
    }
    const results = await captureFixtures({
      outDir: resolve(args.out),
      backends: args.backend ? [args.backend] : undefined,
    });
    for (const r of results) console.log(formatCaptured(r));
    process.exitCode = results.some((r) => r.status === "captured") ? 0 : 1;
  },
});
