import { gitToplevel } from "../infra/git.ts";
import { HOST_ARG, terminalHost } from "./host-arg.ts";
import { defineCommand } from "citty";
import type { OrchestrationHost } from "../domain/host.ts";
import { assertProfileName, DECISION_UNSET_FIX } from "../domain/profile.ts";
import { errorMessage, isCatherdError } from "../domain/errors.ts";
import { configDir } from "../infra/paths.ts";
import { VERSION } from "../infra/version.ts";
import { doctor } from "../services/doctor.ts";
import { type IndexStatus, refreshIndex } from "../services/catalog-service.ts";
import { migrateCredentials } from "../services/credentials.ts";
import {
  type DecisionConfig,
  decisionKey,
  probeDecision,
  saveDecisionKey,
} from "../services/decision-service.ts";
import { reinstallCommand } from "../services/doctor-checks.ts";
import { ensureGlobal, type GlobalInstallDeps, realGlobalInstall } from "../services/global-install.ts";
import { hasProfileFile, type InitResult, initSetup, moveLegacy } from "../services/setup.ts";
import { migrateProfiles, patchProfile } from "../services/profile-service.ts";
import { activeName, getProfile } from "../services/profile-store.ts";
import { formatRefreshed } from "./catalog-command.ts";
import { mark as markOf, refuseInRole } from "./cli-kit.ts";
import { formatReport } from "./doctor-command.ts";
import { mcpHandshake } from "./mcp/handshake.ts";
import { mascot, type State } from "./glyphs.ts";
import { type Prompter, prompter } from "./prompt.ts";

/** What `init` prints last (spec §9.1): the plugin install commands, to paste into a terminal. */
export const PLUGIN_STEPS = [
  "Install the Claude Code plugin:",
  "  claude plugin marketplace add 47vigen/catherd",
  "  claude plugin install catherd@catherd",
  "Then start a new Claude Code session, so it loads the plugin and the catherd agents.",
];

/** The same, for a pre-release build: its plugin comes from the next channel's marketplace. */
export const NEXT_PLUGIN_STEPS = [
  "Install the Claude Code plugin:",
  "  claude plugin marketplace add https://github.com/47vigen/catherd.git#plugin-next",
  "  claude plugin install catherd@catherd-next",
  "Then start a new Claude Code session, so it loads the plugin and the catherd agents.",
];

/** What init prints last: nothing for a plugin that is ready, else the install steps of this version's channel. */
export function pluginSteps(ready: boolean, version: string): string[] {
  if (ready) return [];
  return version.includes("-") ? NEXT_PLUGIN_STEPS : PLUGIN_STEPS;
}

/** Spec §9.3: the full mascot greets `init` nowhere else. */
export function welcomeLines(version: string): string[] {
  const [ears, face, paws] = mascot("good");
  return [ears, `${face}  catherd ${version}`, `${paws}  herds your coding agents`, ""];
}

/** The fixed request `run_start` sends, for `init` to try the typed values with; tests inject one. */
type Probe = (cfg: DecisionConfig, key: string | null) => ReturnType<typeof probeDecision>;

/**
 * The decision model step (plan 44 D25–D27): asks for the url, the model and an optional key, saves them to
 * `profile` (the profile's `decision`, credentials.json's `decisionKey`) and probes the model. A profile that
 * already names one asks nothing. It never stops `init` (Ruling 11): a key that cannot be saved, say because
 * credentials.json is unparsable, is reported with its fix and setup goes on.
 */
export async function decisionStep(
  ask: Prompter | null,
  profile: string,
  d: { host: OrchestrationHost; probe?: Probe },
  plain = false,
): Promise<void> {
  const mark = (state: State) => markOf(state, plain);
  const have = getProfile(profile, d.host).decision;
  let { url, model } = have;
  let key: string | null = null;
  if (url && model) for (let n = 0; n < 3; n++) ask?.skip?.();
  else {
    url = model = null;
    // an empty answer ends the questions, but a piped line is still consumed for each
    if (ask) {
      url = (await ask.ask("Decision model url (https://<your-gateway>/v1): ")) || null;
      if (url) model = (await ask.ask("Decision model name: ")) || null;
      else ask.skip?.();
      if (url && model) key = (await ask.secret("Decision model key (optional; Enter skips): ")) || null;
      else ask.skip?.();
    }
    if (!url || !model)
      return console.log(`- decision model: not set; runs refuse until it is: ${DECISION_UNSET_FIX}`);
    try {
      patchProfile(profile, { decision: { url, model } }, { host: d.host });
    } catch (e) {
      return console.log(
        `${mark("warn")} decision model: could not save it: ${errorMessage(e).split("\n").join(" ")}`,
      );
    }
    if (key)
      try {
        saveDecisionKey(key);
      } catch (e) {
        console.log(
          `${mark("warn")} decision model: could not save the key: ${errorMessage(e).split("\n").join(" ")}`,
        );
        if (isCatherdError(e) && e.fix) console.log(`    fix: ${e.fix}`);
      }
  }
  const r = await (d.probe ?? ((cfg, k) => probeDecision(cfg, { key: k })))(
    { url, model, minConfidence: have.minConfidence },
    key ?? decisionKey(),
  ).catch((e: unknown) => ({ ok: false as const, error: errorMessage(e) }));
  console.log(
    r.ok
      ? `${mark("ok")} decision model: answers in ${r.latencyMs} ms`
      : `${mark("warn")} decision model: ${r.error} (${url})`,
  );
}

/**
 * `init` refreshes the Slopalytics index in the foreground. It never stops `init`;
 * CATHERD_NO_SYNC=1 skips it.
 */
export async function syncStep(
  o: { plain?: boolean; sync?: () => Promise<IndexStatus> } = {},
): Promise<void> {
  const plain = o.plain === true;
  if (process.env.CATHERD_NO_SYNC === "1")
    return console.log("- catalog: not fetched (CATHERD_NO_SYNC=1); catherd catalog sync fetches it");
  console.log("fetching the Slopalytics index…");
  const s = await (o.sync ?? (() => refreshIndex({ auto: true })))().catch(
    (e: unknown) => ({ error: errorMessage(e), pairs: 0 }) as Pick<IndexStatus, "error" | "pairs">,
  );
  if (s.error === null) return console.log(`${markOf("ok", plain)} Slopalytics: ${s.pairs} pairs indexed`);
  console.log(`${markOf("warn", plain)} Slopalytics: ${s.error.split("\n").join(" ")}`);
  console.log("    fix: catherd catalog sync");
}

/**
 * Spec 1.1 §12: installs the global CLI at this version (the plugin's launcher then needs no bunx), and
 * says "installing catherd…" before the resolve. It never stops `init`: a failure is a `!` line and its fix.
 */
export async function globalStep(
  version: string,
  o: { skip: boolean; deps?: GlobalInstallDeps; plain?: boolean },
): Promise<void> {
  const mark = (state: State) => markOf(state, o.plain === true);
  if (o.skip)
    return console.log(`- catherd: not installed globally (--no-global); the plugin starts it with bunx`);
  const r = await ensureGlobal(version, o.deps ?? realGlobalInstall, () =>
    console.log(`installing catherd… (${reinstallCommand(version)})`),
  );
  if (r.state === "current") return console.log(`${mark("ok")} catherd ${version} is installed globally`);
  if (r.state === "installed")
    return console.log(
      `${mark("ok")} catherd ${version} installed globally; the plugin starts it without bunx`,
    );
  if (r.state === "shadowed") {
    const found = r.onPath === null ? "no catherd is on PATH" : `the catherd first on PATH is ${r.onPath}`;
    console.log(
      `${mark("warn")} catherd ${version} installed globally, but ${found}, so the plugin starts it with bunx`,
    );
    return console.log(
      `    fix: put bun's global bin folder (bun pm bin -g) first on PATH, then run catherd init again`,
    );
  }
  console.log(`${mark("warn")} could not install catherd globally: ${r.reason}`);
  console.log(`    fix: ${reinstallCommand(version)}`);
}

/** What happened to the profile: written, kept, or (when the defaults do not validate here) why not. */
export function profileLines(r: InitResult, plain = false): string[] {
  const mark = (state: State) => markOf(state, plain);
  const out: string[] = [];
  if (r.errors.length) {
    out.push(
      `${mark("warn")} profile ${r.profile}: the default profile does not validate here, so it was not written`,
    );
    for (const e of r.errors) {
      out.push(`${mark("warn")} ${e.path}: ${e.message}`);
      if (e.fix) out.push(`    fix: ${e.fix}`);
    }
  }
  if (!r.active)
    out.push(`${mark("warn")} no profile was made active: fix the rows above, then run catherd init again`);
  else
    out.push(
      `${mark("ok")} profile ${r.profile} ${r.created ? "written from the defaults" : "kept as it was"}, and active`,
    );
  return out;
}

/** Spec §8 `catherd init [--no-input]`: first-run setup without the panel. */
export const initCommand = defineCommand({
  meta: {
    name: "init",
    description:
      "First run: the global catherd command, a fetch of the Slopalytics model index, the default profile, its agents, the decision model (url, model, optional key; probed), and a readiness report. Piped, it reads the answers from stdin one per line, a line per question even when this machine skips it (the profile, whether to replace it, the decision model's url, model and key), and waits for stdin to close; --no-input asks nothing",
  },
  args: {
    ...HOST_ARG,
    // citty reads --no-input as input: false, whatever the flag is named; naming it no-input shows it as is
    "no-input": { type: "boolean", description: "ask nothing: keep what exists, else write the defaults" },
    // read as global: false, like no-input above
    "no-global": {
      type: "boolean",
      description: "do not install the global catherd command (bun add -g catherd-cli@<this version>)",
    },
    profile: {
      type: "string",
      description: "the profile to set up and make active (default: current repo profile)",
    },
    plain: { type: "boolean", description: "ASCII glyphs (NO_COLOR drops only colour)" },
  },
  async run({ args }) {
    refuseInRole(process.env, "catherd init");
    // a bad --profile is refused before any question is asked
    if (args.profile !== undefined) assertProfileName(args.profile);
    const ask = (args as { input?: boolean }).input === false ? null : await prompter();
    const plain = args.plain === true;
    const mark = (state: State) => markOf(state, plain);
    try {
      if (process.stdout.isTTY) for (const line of welcomeLines(VERSION)) console.log(line);
      console.log(`catherd ${VERSION}: setting up in ${configDir()}`);
      await globalStep(VERSION, { skip: (args as { global?: boolean }).global === false, plain });
      try {
        migrateCredentials();
        for (const m of migrateProfiles())
          for (const note of m.notes) console.log(`${mark("ok")} profile ${m.profile}: ${note}`);
      } catch (e) {
        console.log(`${mark("warn")} could not migrate 1.5 files: ${errorMessage(e).split("\n").join(" ")}`);
        if (isCatherdError(e) && e.fix) console.log(`    fix: ${e.fix}`);
      }
      await syncStep({ plain });
      const repo = await gitToplevel(process.cwd());
      // 0.x files go first, so a legacy profile about to be moved aside is never asked about
      const moved = moveLegacy();
      const current = activeName(repo);
      if (args.profile !== undefined) ask?.skip?.();
      const selected =
        args.profile ?? (ask ? (await ask.ask(`Profile to set up [${current}]: `)) || undefined : undefined);
      const name = assertProfileName(selected ?? current);
      const exists = hasProfileFile(name);
      if (!exists) ask?.skip?.();
      const overwrite =
        ask !== null &&
        exists &&
        /^y(es)?$/i.test(await ask.ask(`Replace profile ${name} with the default profile? [y/N] `));
      const r = await initSetup({ profile: selected, repo, overwrite, host: terminalHost(args.host) });
      for (const f of [...moved, ...r.moved]) console.log(`${mark("ok")} moved a 0.x file aside: ${f}`);
      for (const l of profileLines(r, plain)) console.log(l);
      if (r.active) await decisionStep(ask, r.profile, { host: terminalHost(args.host).host }, plain);
      else for (let n = 0; n < 3; n++) ask?.skip?.();
      if (r.synced?.linked.length)
        console.log(`${mark("ok")} Claude agents linked: ${r.synced.linked.join(", ")}`);
      for (const x of r.refreshed) console.log(formatRefreshed(x, plain));
      console.log("");
      const report = await doctor({
        host: terminalHost(args.host),
        repo,
        bunVersion: Bun.version,
        version: VERSION,
        handshake: () => mcpHandshake(),
      });
      for (const l of formatReport(report, plain)) console.log(l);
      console.log("");
      const ready = report.checks.some((c) => c.id === "plugin" && c.state === "ok");
      if (terminalHost(args.host).host === "claude-code")
        for (const l of pluginSteps(ready, VERSION)) console.log(l);
    } finally {
      ask?.close();
    }
  },
});
