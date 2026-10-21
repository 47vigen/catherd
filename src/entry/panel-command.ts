import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { gitToplevel } from "../infra/git.ts";
import { defaultDeps } from "./deps.ts";
import { refuseInRole } from "./cli-kit.ts";
import { HOST_ARG, terminalHost } from "./host-arg.ts";
import { type Panel, newToken, servePanel } from "./panel/server.ts";

/** The seams a test replaces: the server, and what keeps `catherd panel` alive until Ctrl-C. */
export const panelServer = {
  serve: servePanel as (o: Parameters<typeof servePanel>[0]) => Panel,
  untilStopped: (): Promise<void> =>
    new Promise((done) => {
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => done());
    }),
};

/** The built panel: `CATHERD_PANEL_DIST`, else the `web/dist` the package ships. */
export const panelDist = (): string =>
  process.env.CATHERD_PANEL_DIST ?? join(import.meta.dir, "../../web/dist");

/** `catherd panel`'s run, and a bare `catherd`'s: serves the panel until Ctrl-C. */
export async function runPanel(o: { port: number; open: boolean; host?: string }): Promise<void> {
  refuseInRole(process.env, "catherd panel");
  const distDir = panelDist();
  if (!existsSync(join(distDir, "index.html")))
    throw new CatherdError("E_CONFIG_INVALID", "the panel is not built", { fix: "bun run panel:build" });
  const token = newToken();
  const panel = panelServer.serve({
    deps: defaultDeps(terminalHost(o.host)),
    repo: await gitToplevel(process.cwd()),
    token,
    port: o.port,
    distDir,
    open: o.open,
  });
  console.log(`catherd panel: ${panel.url}/login#token=${token}`);
  console.log("Ctrl-C stops it.");
  await panelServer.untilStopped();
  await panel.stop();
}

/** `catherd panel [--port <n>] [--no-open]`: Setup, Runs and Questions in your browser, on 127.0.0.1 only. */
export const panelCommand = defineCommand({
  meta: {
    name: "panel",
    description: "Serve the panel on 127.0.0.1 and open it in your browser (a bare catherd does the same)",
  },
  args: {
    port: { type: "string", default: "4317", description: "the port (0 picks a free one)" },
    open: {
      type: "boolean",
      default: true,
      description: "open the browser (--no-open prints the link only)",
    },
    ...HOST_ARG,
  },
  async run({ args }) {
    const port = Number(args.port);
    if (!/^\d+$/.test(args.port) || port > 65535)
      throw new CatherdError("E_INPUT_INVALID", `--port takes a number from 0 to 65535, not "${args.port}"`, {
        fix: "catherd panel --port 4317",
      });
    await runPanel({ port, open: args.open, host: args.host });
  },
});
