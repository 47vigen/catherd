/**
 * The panel the web e2e drives: a seeded home and two runs, no model, no daemon, no backend CLI on PATH. Playwright
 * runs on Node and cannot import src/ or test/helpers.ts, so this file starts the server and writes where its
 * runs live to $CATHERD_E2E_STATE.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RunEventSchema, type RunEventInput } from "../src/domain/run-events.ts";
import { defaultDeps } from "../src/entry/deps.ts";
import { servePanel } from "../src/entry/panel/server.ts";
import { daemonLauncher } from "../src/services/daemon.ts";
import { runStart } from "../src/services/run-client.ts";
import { appendEvent, eventsFile } from "../src/services/run-events-store.ts";
import { findRun } from "../src/services/run-store.ts";
import { tempRepo, withHome } from "./helpers.ts";

const state = process.env.CATHERD_E2E_STATE;
if (!state) throw new Error("set CATHERD_E2E_STATE to the file the seeded paths are written to");

const home = withHome();
const repo = tempRepo();
// no backend CLI is found, so Setup shows each one as missing, and nothing a run starts can reach a model
process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
process.env.CATHERD_NO_SYNC = "1";
process.env.ANTHROPIC_API_KEY = "";
daemonLauncher.launch = () => 0;

const deps = defaultDeps({ host: "codex", session: null, conflict: null });
const RUNG = "codex:gpt-6-sol#high";

async function add(run: string, e: RunEventInput): Promise<void> {
  RunEventSchema.parse({ v: 1, seq: 1, at: new Date().toISOString(), ...e });
  await appendEvent(findRun(run), e);
}

const a = await runStart(deps, { repo, title: "wallet split", aLines: ["A1 the wallet ids stay"] });
await add(a.run, {
  type: "plan.ready",
  milestones: [
    {
      id: "M1",
      title: "wallet split",
      after: [],
      lanes: [
        { id: "M1.L1", role: "worker", kind: "repo_code", after: [], owns: ["src/wallet.ts"] },
        { id: "M1.L2", role: "worker", kind: "repo_code", after: [], owns: ["src/ids.ts"] },
      ],
    },
  ],
});
await add(a.run, { type: "plan.approved", by: "input" });
await add(a.run, {
  type: "lanes.routed",
  milestone: "M1",
  lanes: [
    { lane: "M1.L1", rung: RUNG, ladder: [RUNG] },
    { lane: "M1.L2", rung: RUNG, ladder: [RUNG] },
  ],
});
await add(a.run, {
  type: "dispatch.started",
  dispatchId: "D0001",
  name: "worker-M1.L1",
  role: "worker",
  unit: "M1.L1",
  lane: "M1.L1",
  rung: RUNG,
  thread: null,
});
await add(a.run, {
  type: "question.parked",
  unit: "M1.L2",
  question: "Keep the old wallet id?",
  reason: "needs_user",
});

const b = await runStart(deps, { repo, title: "docs pass", aLines: ["A1 the docs read well"] });
await add(b.run, { type: "run.ended", outcome: "done", reportPath: null });

const panel = servePanel({
  deps,
  repo,
  token: "e2e-token",
  open: false,
  port: 4318,
  distDir: join(import.meta.dir, "../web/dist"),
  pollMs: 100,
});
mkdirSync(dirname(state), { recursive: true });
writeFileSync(
  state,
  JSON.stringify({ home, a: { id: a.run, events: eventsFile(findRun(a.run)) }, b: { id: b.run } }),
);
console.log(`panel e2e server on ${panel.url}`);
