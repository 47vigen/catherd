import { gitToplevel } from "../infra/git.ts";
import { CatherdError } from "../domain/errors.ts";
import { HOST_ARG, terminalHost, withThread } from "./host-arg.ts";
import { defineCommand } from "citty";
import { VERSION } from "../infra/version.ts";
import { type DoctorReport, doctor } from "../services/doctor.ts";
import type { Check } from "../services/doctor-checks.ts";
import { EXIT, JSON_ARG, mark, printJson } from "./cli-kit.ts";
import { mcpHandshake } from "./mcp/handshake.ts";
import { probeRoleServer } from "../infra/role-mcp.ts";

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
    "test-push": {
      type: "boolean",
      description:
        "send one labeled smoke to the validated original session (receipt does not prove processing)",
    },
    thread: {
      type: "string",
      description:
        "with --test-push: the Codex thread to send the smoke to (Codex does not export it to the commands it runs)",
    },
    plain: { type: "boolean", description: "ASCII glyphs (NO_COLOR drops only colour)" },
  },
  async run({ args }) {
    if (args.thread !== undefined && args["test-push"] !== true)
      throw new CatherdError("E_INPUT_INVALID", "--thread only names where --test-push sends its smoke", {
        fix: `catherd doctor --test-push --thread ${args.thread}`,
      });
    const r = await doctor({
      host: withThread(terminalHost(args.host), args.thread),
      repo: await gitToplevel(process.cwd()),
      bunVersion: Bun.version,
      version: VERSION,
      handshake: () => mcpHandshake(),
      roleServerStart: () => probeRoleServer(),
      testPush: args["test-push"] === true,
    });
    if (args.json) printJson(r);
    else for (const l of formatReport(r, args.plain === true)) console.log(l);
    process.exitCode = r.ready ? EXIT.ok : EXIT.notReady;
  },
});
