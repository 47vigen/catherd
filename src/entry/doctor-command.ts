import { gitToplevel } from "../infra/git.ts";
import { HOST_ARG, terminalHost } from "./host-arg.ts";
import { defineCommand } from "citty";
import { VERSION } from "../infra/version.ts";
import { type DoctorReport, doctor } from "../services/doctor.ts";
import { probePush } from "../services/doctor-push.ts";
import type { Check } from "../services/doctor-checks.ts";
import { EXIT, JSON_ARG, mark, printJson } from "./cli-kit.ts";
import { mcpHandshake } from "./mcp/handshake.ts";

/**
 * One row per check: `✓ ready  Bun — 1.4.2`, then the full fix on its own line; a fix of several lines
 * (one command each) keeps them under the first.
 */
export function formatCheck(c: Check, plain = false): string[] {
  return [
    `${mark(c.state, plain)} ${c.word.padEnd(18)} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`,
    ...(c.fix ? c.fix.split("\n").map((l, i) => `${i ? "         " : "    fix: "}${l}`) : []),
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
    ...HOST_ARG,
    ...JSON_ARG,
    plain: { type: "boolean", description: "ASCII glyphs (NO_COLOR drops only colour)" },
  },
  async run({ args }) {
    const r = await doctor({
      host: terminalHost(args.host),
      repo: await gitToplevel(process.cwd()),
      bunVersion: Bun.version,
      version: VERSION,
      handshake: () => mcpHandshake(),
      push: () => probePush(),
    });
    if (args.json) printJson(r);
    else for (const l of formatReport(r, args.plain === true)) console.log(l);
    process.exitCode = r.ready ? EXIT.ok : EXIT.notReady;
  },
});
