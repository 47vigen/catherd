import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CatherdError } from "../../domain/errors.ts";
import { ID_PATTERN } from "../../domain/ids.ts";
import { PROFILE_NAME, ProfilePatchSchema } from "../../domain/profile.ts";
import { knownQueueCapability } from "../../infra/codex-queue.ts";
import { gitToplevel } from "../../infra/git.ts";
import { redact } from "../../infra/log.ts";
import { registerSavedSecrets } from "../../services/jev-service.ts";
import { pausesOver } from "../../services/pause.ts";
import type { Deps } from "../../services/ports.ts";
import { inspectionHost } from "../../services/run-debug.ts";
import { answerUnit, cancelRun, profileTool, runResult, runStart } from "../../services/run-client.ts";
import { listRunViews, type RunView, runView } from "../../services/run-read.ts";
import { findRun, listRuns } from "../../services/run-store.ts";
import { handle } from "./result.ts";

const RUN = z.string().min(1);
const PROFILE = z.string().regex(PROFILE_NAME).optional();

/**
 * The git toplevel of `repo` (default: this server's directory, null outside a repository). A `repo` given
 * outside a repository is refused: never the global profile in its stead.
 */
const toplevel = async (repo: string | undefined): Promise<string | null> => {
  const top = await gitToplevel(repo ?? process.cwd());
  if (top === null && repo !== undefined)
    throw new CatherdError("E_IO_PATH", `${repo} is not inside a git repository`, {
      fix: "pass the path of the repository, or leave repo out for the active profile",
    });
  return top;
};

/** The runs `status` shows without a name: every unfinished one, else the newest. */
const unfinished = (v: RunView): boolean => (v.phase === null ? v.live.length > 0 : v.phase !== "ended");

/** The six tools of a session: a run is started, watched, answered, cancelled and read; the profile is its own. */
export function registerSessionTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "run_start",
    {
      description:
        "Start a run that drives itself: catherd plans, dispatches, reviews, verifies and lands each milestone in a background daemon. Returns the run id and the ntfy url its questions go to.",
      inputSchema: {
        repo: z.string().min(1),
        title: z.string().min(1),
        a_lines: z.array(z.string().min(1)).min(1),
        plan: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe(
            "The reviewed plan files the run implements as written (paths, relative to repo or absolute). Without one, the architect writes a plan and the run waits for your approval.",
          ),
      },
    },
    (a) => handle(() => runStart(deps, { repo: a.repo, title: a.title, aLines: a.a_lines, plan: a.plan })),
  );

  server.registerTool(
    "status",
    {
      description:
        "Each run's phase, milestones, live roles, parked questions and quota holds, and whether its daemon is alive (a dead one is restarted). Without a run: every unfinished run, else the newest.",
      inputSchema: { run: RUN.optional() },
    },
    (a) =>
      handle(() => {
        registerSavedSecrets();
        const listing = a.run ? null : listRuns();
        const views = a.run ? [runView(deps, a.run)] : listRunViews(deps);
        const open = views.filter(unfinished);
        const shown = a.run ? views : open.length ? open : views.slice(0, 1);
        const queue =
          deps.host.host === "codex" && !deps.host.conflict ? knownQueueCapability(process.env) : null;
        return redact({
          // a pause (the machine's, a workspace's) covers the runs shown, and comes first
          paused: pausesOver(
            (listing?.runs ?? [findRun(a.run as string)]).filter((r) => shown.some((v) => v.id === r.id)),
          ),
          version: deps.version,
          host: inspectionHost(deps.host),
          queue,
          runs: shown,
          warnings: (listing?.corrupt ?? []).map((c) => `skipped run ${c.id}: ${c.reason}`),
        });
      }),
  );

  server.registerTool(
    "answer",
    {
      description: "Answer a parked unit (the run, a milestone or a lane): it runs again with your answer.",
      inputSchema: { run: RUN, unit: z.string().min(1), answer: z.string().min(1) },
    },
    (a) => handle(() => answerUnit(deps, a)),
  );

  server.registerTool(
    "cancel",
    {
      description: "Stop the run: every live role is cancelled and the run ends.",
      inputSchema: { run: RUN },
    },
    (a) => handle(() => cancelRun(deps, a)),
  );

  server.registerTool(
    "result",
    {
      description:
        "The run's report (the MR body: digests, known issues, the judge's decisions), or with name one role's record.",
      inputSchema: { run: RUN, name: z.string().regex(ID_PATTERN).optional() },
    },
    (a) => handle(() => runResult(deps, a)),
  );

  server.registerTool(
    "profile",
    {
      description:
        "Read, validate or change a profile, or set notify_url, where parked questions are sent. Without a name: the profile this repo runs on (repo, default this server's directory).",
      inputSchema: {
        action: z.enum(["get", "validate", "set"]),
        name: PROFILE,
        repo: z.string().min(1).optional(),
        patch: ProfilePatchSchema.optional(),
        notify_url: z.string().min(1).optional(),
      },
    },
    (a) =>
      handle(async () =>
        profileTool(deps, {
          action: a.action,
          name: a.name,
          repo: (await toplevel(a.repo)) ?? undefined,
          patch: a.patch,
          notifyUrl: a.notify_url,
        }),
      ),
  );
}
