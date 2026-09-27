import { defineCommand } from "citty";
import { VERSION } from "../infra/version.ts";
import { type Check, type DoctorReport, doctor } from "../services/doctor.ts";
import { EXIT, JSON_ARG, mark, printJson } from "./cli-kit.ts";
import { mcpHandshake } from "./mcp/handshake.ts";

/** One row per check: `✓ ready  Bun — 1.4.2`, then the full fix command on its own line. */
export function formatCheck(c: Check, plain = false): string[] {
  return [
    `${mark(c.state, plain)} ${c.word.padEnd(18)} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`,
    ...(c.fix ? [`    fix: ${c.fix}`] : []),
  ];
}

export function formatReport(r: DoctorReport, plain = false): string[] {
  return [
    ...r.checks.flatMap((c) => formatCheck(c, plain)),
    "",
    r.ready
      ? `${mark("ok", plain)} ready`
      : `${mark("fail", plain)} not ready: fix the rows marked ${mark("fail", plain)} above`,
  ];
}

/** Spec §8, §10.3: `catherd doctor [--json]`, exit 3 when not ready. */
export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Readiness report: Bun, backends, Jev, the plugin, agents, the MCP server, locks",
  },
  args: {
    ...JSON_ARG,
    plain: { type: "boolean", description: "ASCII glyphs (NO_COLOR drops only colour)" },
  },
  async run({ args }) {
    const r = await doctor({ bunVersion: Bun.version, version: VERSION, handshake: () => mcpHandshake() });
    if (args.json) printJson(r);
    else for (const l of formatReport(r, args.plain === true)) console.log(l);
    process.exitCode = r.ready ? EXIT.ok : EXIT.notReady;
  },
});
