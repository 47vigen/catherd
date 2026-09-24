import { readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendRoute, CLIMB_REASONS, currentRoute, ID } from "../core/lanes.ts";
import { appendLedger } from "../core/runstore.ts";
import { agentName } from "../profile/agents.ts";
import { activeProfileName, loadProfile } from "../profile/profile.ts";
import { loadCatalog } from "../routing/catalog.ts";
import { askFinding, askSameDefect, nextRung, route as routeLane } from "../routing/route.ts";
import { defaultLadder } from "../routing/select.ts";
import { type Backend, type Catalog, ROLES, type Role, type RungId } from "../types.ts";
import { json } from "./out.ts";
import { backendOf, findRun, refreshState, runFile } from "./runs.ts";

export function targetOf(c: Catalog, role: Role, rung: RungId): { backend: Backend; agent?: string } {
  const backend = backendOf(c, rung);
  return backend === "claude" ? { backend, agent: agentName(role, rung) } : { backend };
}

const cell = (s: string) => s.replace(/[|\n]/g, "/").replace(/\s+/g, " ").trim();

/** git's short commit exists check: does `<commit>^{commit}` resolve in `repo`? */
function commitExists(repo: string, commit: string): boolean {
  return Bun.spawnSync(["git", "-C", repo, "cat-file", "-e", `${commit}^{commit}`]).success;
}

export function registerLaneTools(server: McpServer): void {
  server.registerTool(
    "route",
    {
      description:
        "The rung for a lane (decided by Jev from its lane file, lanes/<id>.md) or, without a lane file, for a role (the profile's default), with the ladder above it. A Claude rung comes with the agent to run it as.",
      inputSchema: {
        run: z.string(),
        lane_file: z.string().optional(),
        role: z.enum(ROLES).default("worker"),
      },
    },
    async (a) => {
      const run = findRun(a.run);
      const profile = loadProfile(activeProfileName(run.meta.repo));
      const catalog = loadCatalog();
      if (!a.lane_file) {
        const d = defaultLadder(profile, catalog, a.role);
        return json({
          role: a.role,
          rung: d.rung,
          ladder: d.ladder,
          source: "default",
          ...targetOf(catalog, a.role, d.rung),
        });
      }
      const file = runFile(run, a.lane_file, "read");
      const lane = basename(file, ".md");
      if (!ID.test(lane) || relative(run.dir, file) !== join("lanes", `${lane}.md`)) {
        throw new Error(`catherd: a lane file lives at lanes/<id>.md, not ${a.lane_file}`);
      }
      const d = await routeLane({
        runDir: run.dir,
        profile,
        catalog,
        role: a.role,
        laneText: readFileSync(file, "utf8"),
      });
      appendRoute(run.dir, {
        at: new Date().toISOString(),
        lane,
        role: a.role,
        rung: d.rung,
        ladder: d.ladder,
        source: "route",
        from: null,
        reason: null,
        kind: d.kind,
        difficulty: d.difficulty,
        jev: d.source,
      });
      return json({ lane, role: a.role, ...d, ...targetOf(catalog, a.role, d.rung) });
    },
  );

  server.registerTool(
    "climb",
    {
      description:
        "Move a routed lane one rung up its ladder and record why. Returns the next rung, or top: true when there is none. Dispatch the lane again on a fresh thread.",
      inputSchema: {
        run: z.string(),
        lane: z.string().regex(ID),
        reason: z.enum(CLIMB_REASONS),
        evidence: z.string().optional(),
      },
    },
    async (a) => {
      const run = findRun(a.run);
      const cur = currentRoute(run.dir, a.lane);
      if (!cur) throw new Error(`catherd: lane ${a.lane} was never routed; call route first`);
      const next = nextRung(cur.ladder, cur.rung);
      appendRoute(run.dir, {
        ...cur,
        at: new Date().toISOString(),
        source: "climb",
        from: cur.rung,
        rung: next ?? cur.rung,
        reason: a.evidence ? `${a.reason}: ${a.evidence}` : a.reason,
      });
      await refreshState(run, {
        next: next
          ? `dispatch ${a.lane} at ${next} on a fresh thread`
          : `${a.lane} failed on its top rung: ask finding, then the architect or the report`,
      });
      if (!next) return json({ lane: a.lane, rung: cur.rung, top: true });
      return json({ lane: a.lane, rung: next, top: false, ...targetOf(loadCatalog(), cur.role, next) });
    },
  );

  server.registerTool(
    "ask",
    {
      description:
        "Ask Jev one fixed question. finding: state { lane_file, finding } → design | code | unclear. same-defect: state { before, after } → yes | no. Falls back to the default when Jev is unsure or down. Keep the state short, in English, and free of secrets.",
      inputSchema: {
        run: z.string(),
        question: z.enum(["finding", "same-defect"]),
        state: z.record(z.string(), z.string()),
      },
    },
    async (a) => {
      const run = findRun(a.run);
      const need = (k: string) => {
        const v = a.state[k];
        if (!v) throw new Error(`catherd: ${a.question} needs state.${k}`);
        return v;
      };
      if (a.question === "finding") {
        const laneText = readFileSync(runFile(run, need("lane_file"), "read"), "utf8");
        return json(await askFinding(run.dir, laneText, need("finding")));
      }
      return json(await askSameDefect(run.dir, need("before"), need("after")));
    },
  );

  server.registerTool(
    "land",
    {
      description:
        "Record a landed milestone after you commit it: appends its ledger row and rewrites state.md with its evidence as the last check and the next step.",
      inputSchema: {
        run: z.string(),
        milestone: z.string().min(1),
        what: z.string().min(1),
        commit: z.string().regex(/^[0-9a-f]{7,40}$/),
        evidence: z.string().min(1),
        next: z.string().min(1),
      },
    },
    async (a) => {
      const run = findRun(a.run);
      if (!commitExists(run.meta.repo, a.commit))
        throw new Error(`catherd: no commit ${a.commit} in ${run.meta.repo}`);
      const row = [a.milestone, a.what, a.commit, a.evidence].map(cell).join(" | ");
      appendLedger(run.dir, row);
      await refreshState(run, { lastCheck: cell(a.evidence), next: a.next });
      return json({ ledger: row });
    },
  );
}
