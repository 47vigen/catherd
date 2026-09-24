import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ID } from "../core/lanes.ts";
import { createRun, listRuns, readRunRecords, rolePaths } from "../core/runstore.ts";
import { formatSummary, summarizeRun } from "../core/status.ts";
import { jevKey } from "../routing/jev.ts";
import { json, text } from "./out.ts";
import { findRun, refreshState, runFile } from "./runs.ts";

const CAP_LINES = 250;
const CAP_CHARS = 20_000;

export function capReply(reply: string, path: string): string {
  const lines = reply.split("\n");
  const head = lines.length > CAP_LINES ? lines.slice(0, CAP_LINES).join("\n") : reply;
  if (head === reply && reply.length <= CAP_CHARS) return reply;
  return `${head.slice(0, CAP_CHARS)}\n[capped: the full reply is ${path}]`;
}

/** git's toplevel for `repo`, or null when it is not inside a git repository. */
function gitToplevel(repo: string): string | null {
  const proc = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.success ? proc.stdout.toString("utf8").trim() : null;
}

export function registerRunTools(server: McpServer): void {
  server.registerTool(
    "run_start",
    {
      description:
        "Start a catherd run for a git repository: creates its run folder (outside the repo) and state.md. Returns the run id and the folder.",
      inputSchema: {
        repo: z.string().min(1),
        title: z.string().min(1),
        a_lines: z.array(z.string().min(1)).min(1),
      },
    },
    async ({ repo, title, a_lines }) => {
      if (!jevKey()) throw new Error("catherd: no Jev key. Run `npx catherd init` in a terminal first.");
      const top = gitToplevel(repo);
      if (!top) throw new Error(`catherd: ${repo} is not inside a git repository`);
      const run = createRun(top, title, a_lines);
      return json({ run: run.id, dir: run.dir });
    },
  );

  server.registerTool(
    "write_run_file",
    {
      description:
        "Write a file inside a run folder: plan.md, lanes/Mx.Ly.md, a dossier or notes. The path is relative to the run folder; catherd's own files are refused.",
      inputSchema: { run: z.string(), path: z.string().min(1), content: z.string() },
    },
    async (a) => {
      const file = runFile(findRun(a.run), a.path, "write");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, a.content);
      return json({ path: file, bytes: Buffer.byteLength(a.content) });
    },
  );

  server.registerTool(
    "read_run_file",
    {
      description: "Read a file inside a run folder. The path is relative to the run folder.",
      inputSchema: { run: z.string(), path: z.string().min(1) },
    },
    async (a) => text(readFileSync(runFile(findRun(a.run), a.path, "read"), "utf8")),
  );

  server.registerTool(
    "status",
    {
      description:
        "One screen on a run: the state.md tail, live roles with their age, totals, Jev fallbacks and the harness cost. Without a run: every run with live roles, else the newest run.",
      inputSchema: { run: z.string().optional() },
    },
    async (a) => {
      if (a.run) return text(formatSummary(summarizeRun(findRun(a.run))));
      const runs = listRuns();
      if (runs.length === 0) return text("catherd: no runs yet");
      const all = runs.map(summarizeRun);
      const live = all.filter((s) => s.live.length > 0);
      return text((live.length ? live : all.slice(0, 1)).map(formatSummary).join("\n\n"));
    },
  );

  server.registerTool(
    "result",
    {
      description: "A role's latest reply, capped, and its RESULT record.",
      inputSchema: { run: z.string(), name: z.string().regex(ID) },
    },
    async (a) => {
      const run = findRun(a.run);
      const p = rolePaths(run.dir, a.name);
      const reply = existsSync(p.out) ? readFileSync(p.out, "utf8") : "";
      const record = readRunRecords(run.dir).findLast((r) => r.name === a.name) ?? null;
      return json({ reply: capReply(reply, p.out), record });
    },
  );

  server.registerTool(
    "set_next",
    {
      description:
        "Record the run's next step, the last line of state.md: when pausing, or when the plan changes. dispatch, climb and land write state.md themselves.",
      inputSchema: { run: z.string(), next: z.string().min(1) },
    },
    async (a) => {
      const run = findRun(a.run);
      await refreshState(run, { next: a.next });
      return text(readFileSync(join(run.dir, "state.md"), "utf8"));
    },
  );
}
