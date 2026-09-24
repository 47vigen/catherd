import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fastCheckOf } from "../core/lanes.ts";
import { acquire, resolveSlots } from "../core/lock.ts";
import { json } from "./out.ts";
import { findRun } from "./runs.ts";

const TAIL_LINES = 20;

interface PreflightResult {
  lane: string;
  check: string;
  pass: boolean;
  tail: string[];
}

async function runCheck(cwd: string, check: string): Promise<{ pass: boolean; tail: string[] }> {
  const proc = Bun.spawn(["sh", "-c", check], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const tail = `${out}${err}`
    .split("\n")
    .filter((l) => l.trim())
    .slice(-TAIL_LINES);
  return { pass: code === 0, tail };
}

export function registerPreflight(server: McpServer): void {
  server.registerTool(
    "preflight",
    {
      description:
        "Runs each lane's fast check once, on the base tree, behind the machine-wide heavy-command lock, and reports pass/fail per lane with the tail of its output. Call it after the lane files exist and before dispatching any lane.",
      inputSchema: { run: z.string() },
    },
    async (a) => {
      const run = findRun(a.run);
      const dir = join(run.dir, "lanes");
      const files = existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith(".md"))
            .sort()
        : [];
      const held = await acquire(resolveSlots(), `preflight ${run.id}`);
      try {
        const results: PreflightResult[] = [];
        for (const f of files) {
          const lane = f.slice(0, -".md".length);
          const text = readFileSync(join(dir, f), "utf8");
          const check = fastCheckOf(text);
          if (!check) {
            results.push({ lane, check: "", pass: false, tail: [`lanes/${f} has no "Fast check:" line`] });
            continue;
          }
          const r = await runCheck(run.meta.repo, check);
          results.push({ lane, check, ...r });
        }
        return json({ results, allPass: results.every((r) => r.pass) });
      } finally {
        await held.release();
      }
    },
  );
}
