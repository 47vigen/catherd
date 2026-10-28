/**
 * The panel the web e2e drives: a seeded home, two runs, the fixture run and a live run, no model, no daemon, no
 * backend CLI on PATH. Playwright
 * runs on Node and cannot import src/ or test/helpers.ts, so this file starts the server and writes where its
 * runs live to $CATHERD_E2E_STATE.
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVENTS_SCHEMA, RunEventSchema, type RunEventInput } from "../src/domain/run-events.ts";
import { defaultDeps } from "../src/entry/deps.ts";
import { servePanel } from "../src/entry/panel/server.ts";
import { daemonLauncher } from "../src/services/daemon.ts";
import { runStart } from "../src/services/run-client.ts";
import { appendEvent, readEvents } from "../src/services/run-events-store.ts";
import { dispatchDir } from "../src/services/run-files.ts";
import { patchProfile } from "../src/services/profile-service.ts";
import { activeName, profileFile } from "../src/services/profile-store.ts";
import { findRun } from "../src/services/run-store.ts";
import { seedFixtureRun } from "./services/fixture-run.ts";
import { tempRepo, withHome } from "./helpers.ts";

const state = process.env.CATHERD_E2E_STATE;
if (!state) throw new Error("set CATHERD_E2E_STATE to the file the seeded paths are written to");

const home = withHome();
const repo = tempRepo();
// no backend CLI is found, so Setup shows each one as missing, and nothing a run starts can reach a model: bun's own
// directory can hold claude or codex too, so PATH gets a directory with bun alone
const bin = join(home, "bin");
mkdirSync(bin, { recursive: true });
symlinkSync(process.execPath, join(bin, "bun"));
process.env.PATH = `${bin}:/usr/bin:/bin`;
process.env.CATHERD_NO_SYNC = "1";
process.env.ANTHROPIC_API_KEY = "";
daemonLauncher.launch = () => 0;

const deps = defaultDeps({ host: "codex", session: null, conflict: null });
const RUNG = "codex:gpt-6-sol#high";
// a run starts only with a decision model that answers the probe: a named one, probed by a stub
patchProfile(
  activeName(repo),
  { decision: { url: "https://decider.example/v1", model: "test-decider" } },
  { host: "codex" },
);
deps.routing.probe = async () => ({ ok: true, latencyMs: 1 });

async function add(run: string, e: RunEventInput): Promise<void> {
  RunEventSchema.parse({ v: EVENTS_SCHEMA, seq: 1, at: new Date().toISOString(), ...e });
  await appendEvent(findRun(run), e);
}

const a = await runStart(deps, { repo, title: "wallet split", aLines: ["A1 the wallet ids stay"] });
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

const fixture = seedFixtureRun();

// "live split": one worker mid-way, with a question parked on another unit
const live = await runStart(deps, { repo, title: "live split", aLines: ["A1 the split holds"] });
await add(live.run, {
  type: "dispatch.started",
  dispatchId: "D0101",
  name: "worker-M1.L1",
  role: "worker",
  unit: "M1.L1",
  lane: "M1.L1",
  rung: RUNG,
  thread: null,
});
const liveRun = findRun(live.run);
const dir = dispatchDir(liveRun, "D0101");
mkdirSync(dir, { recursive: true });
const transcript = readFileSync(
  join(import.meta.dir, "fixtures/transcript/codex-worker.jsonl"),
  "utf8",
).split("\n");
writeFileSync(join(dir, "events.jsonl"), `${transcript.slice(0, 10).join("\n")}\n`);
await add(live.run, {
  type: "question.parked",
  unit: "M1.L2",
  question: "Merge the split ids?",
  reason: "needs_user",
});

const panel = servePanel({
  deps,
  repo,
  token: "e2e-token",
  reusableToken: true,
  open: false,
  port: Number(process.env.CATHERD_E2E_PORT ?? 4318),
  distDir: join(import.meta.dir, "../web/dist"),
  pollMs: 100,
});
// the specs run on Node and cannot reach the run store: they append to a run's log, and read its last event, through this
const eventsApi = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const run = findRun(new URL(req.url).pathname.slice(1));
    if (req.method === "POST")
      return Response.json(await appendEvent(run, (await req.json()) as RunEventInput));
    return Response.json(readEvents(run).at(-1));
  },
});
const eventsUrl = (id: string) => `${eventsApi.url}${id}`;
mkdirSync(dirname(state), { recursive: true });
writeFileSync(
  state,
  JSON.stringify({
    home,
    a: { id: a.run, events: eventsUrl(a.run) },
    b: { id: b.run },
    fixture: { id: fixture.id },
    live: { id: live.run, events: eventsUrl(live.run), stream: join(dir, "events.jsonl") },
    profile: profileFile(activeName(repo)),
    path: process.env.PATH,
  }),
);
console.log(`panel e2e server on ${panel.url}`);
