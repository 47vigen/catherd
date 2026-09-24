import { writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type DispatchOpts, runCodex } from "../core/codex.ts";
import { recordHarness } from "../core/harness.ts";
import { ID, ownedFilesOf, readLane } from "../core/lanes.ts";
import { runOpencode } from "../core/opencode.ts";
import { reconcileLive } from "../core/reconcile.ts";
import { readLive, rolePaths } from "../core/runstore.ts";
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
      const backend = backendOf(loadCatalog(), a.rung);
      if (backend === "claude") {
        throw new Error(
          `catherd: ${a.rung} is a Claude rung. Run it as Agent(subagent_type: "${agentName(a.role, a.rung)}") instead.`,
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

      const isolated = loadProfile(activeProfileName(run.meta.repo)).harness[backend].isolated;
      const token = extra._meta?.progressToken;
      let tick = 0;
      const o: DispatchOpts = {
        runDir: run.dir,
        name: a.name,
        role: a.role,
        rung: a.rung,
        cwd: run.meta.repo,
        thread: a.thread,
        ownedFiles: owned,
        isolated,
        onProgress:
          token === undefined
            ? undefined
            : (pr) => {
                void extra.sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken: token,
                    progress: ++tick,
                    message: `${a.name} · ${a.rung} · ${pr.secs}s${pr.lastEvent ? ` · ${pr.lastEvent}` : ""}`,
                  },
                });
              },
      };
      const record = await (backend === "codex" ? runCodex(o) : runOpencode(o));
      if (!a.thread) recordHarness(run.dir, record);
      await refreshState(
        run,
        record.status === "limit"
          ? { next: `paused: ${record.backend} usage limit; resume when the user says so` }
          : {},
      );
      return json({ record, hints: dispatchHints(record, owned) });
    },
  );
}
