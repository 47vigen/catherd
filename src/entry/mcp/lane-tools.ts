import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ID_PATTERN } from "../../domain/ids.ts";
import { ROLES } from "../../domain/roles.ts";
import { CatherdError } from "../../domain/errors.ts";
import { CLIMB_REASONS } from "../../domain/route.ts";
import { ask, climb, LAND_SKIPS, land, route, routeLanes } from "../../services/lane-service.ts";
import type { Deps } from "../../services/ports.ts";
import { preflight } from "../../services/preflight.ts";
import { handle } from "./result.ts";

export function registerLaneTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "route",
    {
      description:
        "The rung for a lane (from the lane file's Kind/Difficulty lines when it declares both, else Jev, else the profile default), or with lanes (several lane files) for each of them in one call, Jev asked about all at once ({ routes: [...] }, in order), or, without a lane file, a role's default rung, with the ladder above it: only rungs at least as strong as the start. Rungs are backend:model#effort; a claude: rung comes with the agent to run it as. Returns rung, ladder, backend, agent and why: one line naming the decision, where Jev disagreed with the lane's header, when no rung clears the bar (and the closest), and when a tie between quotas decided. Every decision, with its provenance (each threshold, the value used, its source and date, the rung's cost and run evidence), is written to the run's routes.jsonl. A lane whose Kind: or Difficulty: the catalog does not know is refused with E_LANE_INVALID.",
      inputSchema: {
        run: z.string(),
        lane_file: z.string().optional(),
        lanes: z.array(z.string()).min(1).optional(),
        role: z.enum(ROLES).default("worker"),
      },
    },
    (a) =>
      handle(async () => {
        if (a.lanes && a.lane_file !== undefined)
          throw new CatherdError("E_INPUT_INVALID", "route takes lane_file or lanes, not both", {
            fix: "pass every lane file in lanes",
          });
        return a.lanes
          ? { routes: await routeLanes(deps, { run: a.run, laneFiles: a.lanes, role: a.role }) }
          : route(deps, { run: a.run, laneFile: a.lane_file, role: a.role });
      }),
  );

  server.registerTool(
    "preflight",
    {
      description:
        "Run each lane's fast check once, on the base tree, behind the heavy-command lock, with a 120 s timeout, in the user's login environment plus the repo's gate environment (catherd knowledge env). By default only the lanes of milestones not landed yet; milestone names one. Each lane is pass, fails-as-expected, skipped (it checks a file the lane creates, or a pnpm filter that matches no package yet), cannot-start (a missing command, a timeout, or an environment error: no Docker, DNS, a denied permission; its note says which) or lock-busy (no heavy slot came free within 60 s: run it again); only cannot-start blocks. warnings names each lane whose fast check runs no linter while the repo has one. When the profile asks for confirmation, the first call returns the commands to show the user; call again with confirmed: true. Refused with E_LANE_INVALID, running nothing, while any lane's Kind: or Difficulty: is not one the catalog knows.",
      inputSchema: {
        run: z.string(),
        confirmed: z.boolean().optional(),
        milestone: z.string().regex(ID_PATTERN).optional(),
      },
    },
    (a) => handle(() => preflight(deps, { run: a.run, confirmed: a.confirmed, milestone: a.milestone })),
  );

  server.registerTool(
    "climb",
    {
      description:
        "Move a routed lane one rung up its ladder and record why. Returns the next rung, or top: true, and any hints. Dispatch the lane again at that rung on a fresh thread. Pass env: true when the environment caused it (a missing service, a broken tool, a usage limit), not the rung. Refused with E_CLIMB_DESIGN when the evidence is a design question (Jev's finding answer is design, or a blocked climb's evidence is about lane ownership): send it to the architect instead. Refused with E_CLIMB_ENV when the lane's last reply named the environment on an ENV: line: fix the environment or park the milestone.",
      inputSchema: {
        run: z.string(),
        lane: z.string().regex(ID_PATTERN),
        reason: z.enum(CLIMB_REASONS),
        evidence: z.string().optional(),
        env: z.boolean().optional(),
      },
    },
    (a) => handle(() => climb(deps, a)),
  );

  server.registerTool(
    "ask",
    {
      description:
        "Ask Jev one fixed question. finding: state { lane_file, finding } → design | code | unclear. same-defect: state { before, after } → yes | no. Falls back to the default when Jev is unsure or absent. Keep the state short, in English, and free of secrets.",
      inputSchema: {
        run: z.string(),
        question: z.enum(["finding", "same-defect"]),
        state: z.record(z.string(), z.string()),
      },
    },
    (a) => handle(() => ask(deps, a)),
  );

  server.registerTool(
    "land",
    {
      description:
        "Record a landed milestone after you commit it: its five-column ledger row (with the minutes it took) and state.md's last check and next step, with any hints. learned, when given, goes to this repo's knowledge.md. Returns digest: the milestone's digest (R/digests/<milestone>.md: A-lines, commit, lanes with rungs and climbs, reviewer findings, the verifier's verdict with carried items, minutes and tokens), for the milestone push to link. Refused with E_LAND_GATE unless, since the milestone's lanes started, a reviewer named reviewer-<milestone> ended ok (a dispatch, or a Claude subagent recorded with record_agent_run, role reviewer) and a verifier verdict naming the milestone was recorded ok (record_agent_run, role verifier; a headless verifier's reply opening VERDICT: PASS). A skip over an empty commit range is refused: commit first. skip: docs-only lands a milestone whose commit range changed only docs; skip: no-code one that changed no source file (put the evidence, e.g. a green pipeline, in evidence).",
      inputSchema: {
        run: z.string(),
        milestone: z.string().regex(ID_PATTERN),
        what: z.string().min(1),
        commit: z.string().regex(/^[0-9a-f]{7,40}$/),
        evidence: z.string().min(1),
        next: z.string().min(1),
        learned: z.string().min(1).optional(),
        skip: z.enum(LAND_SKIPS).optional(),
      },
    },
    (a) => handle(() => land(deps, a)),
  );
}
