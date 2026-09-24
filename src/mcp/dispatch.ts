import { writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DispatchOpts, runCodex } from "../core/codex.ts";
import { recordHarness } from "../core/harness.ts";
import { ID, ownedFilesOf, readLane } from "../core/lanes.ts";
import { runOpencode } from "../core/opencode.ts";
import { reconcileLive } from "../core/reconcile.ts";
import { readLive, rolePaths } from "../core/runstore.ts";
import { budgetStatus, formatBudget, summarizeRun } from "../core/status.ts";
import { agentName } from "../profile/agents.ts";
import { activeProfileName, loadProfile } from "../profile/profile.ts";
import { loadCatalog } from "../routing/catalog.ts";
import { ROLES, type RunRecord } from "../types.ts";
import { json } from "./out.ts";
import { backendOf, findRun, refreshState } from "./runs.ts";

export function dispatchHints(r: RunRecord, owned: string[]): string[] {
  const h: string[] = [];
  if (r.status === "limit")
    h.push(`limit: ${r.backend} hit a usage limit; the run is paused, report it and push`);
  if (r.status === "cli-too-old")
    h.push(`cli-too-old: tell the user to upgrade ${r.backend}: ${r.error ?? ""}`.trim());
  if (r.status === "failed") h.push(`failed: read roles/${r.name}.err before a retry`);
  if (r.replyStatus === "refused" || r.replyStatus === "blocked") h.push(`climb: ${r.replyStatus}`);
  else if (r.status === "ok" && owned.length > 0 && r.changedOwned.length === 0) h.push("climb: unchanged");
  if (r.threadHeavy) h.push("thread-heavy: its next piece starts on a fresh thread");
  return h;
}

export function registerDispatch(server: McpServer): void {
  server.registerTool(
    "dispatch",
    {
      description:
        "Run one Codex or opencode role and return its RESULT record and hints when it finishes. The brief is the text itself; catherd writes it to roles/<name>.md, or roles/<name>.fix.md when resuming a thread. With lane, the lane file's Owns: line gives the owned files, and a lane overlapping a running one is refused. Call it from the main thread.",
      inputSchema: {
        run: z.string(),
        role: z.enum(ROLES),
        name: z.string().regex(ID),
        brief: z.string().min(1),
        rung: z.string().min(3),
        thread: z.string().optional(),
        lane: z.string().regex(ID).optional(),
        next: z.string().optional(),
      },
    },
    async (a, extra) => {
      const run = findRun(a.run);
      reconcileLive(run.dir);
      const catalog = loadCatalog();
      const backend = backendOf(catalog, a.rung);
      if (backend === "claude") {
        throw new Error(
          `catherd: ${a.rung} is a Claude rung. Run it as Agent(subagent_type: "${agentName(a.role, a.rung)}") instead.`,
        );
      }
      const profile = loadProfile(activeProfileName(run.meta.repo));
      // spec §11b: at 100% of the run budget, refuse rather than start another role that might overrun it.
      const budget = budgetStatus(summarizeRun(run).totals, profile.budget);
      if (budget && budget.fraction >= 1) {
        throw new Error(
          `catherd: run budget exhausted (${formatBudget(budget)}); ask the user before continuing`,
        );
      }
      const owned = a.lane ? ownedFilesOf(readLane(run.dir, a.lane)) : [];
      if (a.lane && owned.length === 0) throw new Error(`catherd: lanes/${a.lane}.md has no "Owns:" line`);
      const live = readLive(run.dir);
      if (live.some((m) => m.name === a.name)) throw new Error(`catherd: ${a.name} is already running`);
      for (const m of live) {
        const shared = m.ownedFiles.filter((f) => owned.includes(f));
        if (shared.length) {
          throw new Error(
            `catherd: ${a.name} owns ${shared.join(", ")}, which running ${m.name} owns; dispatch it after that one`,
          );
        }
      }

      const p = rolePaths(run.dir, a.name);
      writeFileSync(a.thread ? p.fix : p.brief, a.brief);
      await refreshState(run, {
        starting: {
          name: a.name,
          rung: a.rung,
          thread: a.thread ?? null,
          brief: `roles/${a.name}${a.thread ? ".fix" : ""}.md`,
          since: new Date().toISOString().slice(11, 16),
        },
        ...(a.next ? { next: a.next } : {}),
      });

      const token = extra._meta?.progressToken;
      let tick = 0;
      const runOne = (
        rung: string,
        thread: string | undefined,
        rb: "codex" | "opencode",
      ): Promise<RunRecord> => {
        const o: DispatchOpts = {
          runDir: run.dir,
          name: a.name,
          role: a.role,
          rung,
          cwd: run.meta.repo,
          thread,
          ownedFiles: owned,
          isolated: profile.harness[rb].isolated,
          onProgress:
            token === undefined
              ? undefined
              : (pr) => {
                  void extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken: token,
                      progress: ++tick,
                      message: `${a.name} · ${rung} · ${pr.secs}s${pr.lastEvent ? ` · ${pr.lastEvent}` : ""}`,
                    },
                  });
                },
        };
        return rb === "codex" ? runCodex(o) : runOpencode(o);
      };

      let record = await runOne(a.rung, a.thread, backend);
      if (!a.thread) recordHarness(run.dir, record);

      // spec §11b: a limit result re-dispatches on the profile's failover stand-in for this rung.
      const hints: string[] = [];
      const failoverTo = profile.failover?.[a.rung];
      if (record.status === "limit" && failoverTo) {
        const toBackend = backendOf(catalog, failoverTo);
        if (toBackend === "claude") {
          hints.push(
            `limit: ${a.rung} hit a usage limit; its failover ${failoverTo} is a Claude rung — run it as Agent(subagent_type: "${agentName(a.role, failoverTo)}")`,
          );
        } else {
          const failedRung = record.rung;
          record = await runOne(failoverTo, undefined, toBackend);
          if (!a.thread) recordHarness(run.dir, record);
          hints.push(`limit: ${a.role} ${failedRung} hit a usage limit; failed over to ${failoverTo}`);
        }
      }

      await refreshState(
        run,
        record.status === "limit"
          ? { next: `paused: ${record.backend} usage limit; resume when the user says so` }
          : {},
      );
      return json({ record, hints: [...hints, ...dispatchHints(record, owned)] });
    },
  );
}
