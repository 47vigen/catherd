import { gitToplevel } from "../infra/git.ts";
import { HOST_ARG, terminalHost } from "./host-arg.ts";
import { defineCommand } from "citty";
import { assertProfileName } from "../domain/profile.ts";
import { errorMessage, isCatherdError } from "../domain/errors.ts";
import { configDir } from "../infra/paths.ts";
import { VERSION } from "../infra/version.ts";
import { doctor } from "../services/doctor.ts";
import { testAaKey } from "../infra/sources/artificial-analysis.ts";
import { aaKey, saveAaKey } from "../services/credentials.ts";
import { jevKey, saveJevKey, testJevKey } from "../services/jev-service.ts";
import { type SyncReport, syncSources } from "../services/source-sync.ts";
import { reinstallCommand } from "../services/doctor-checks.ts";
import { ensureGlobal, type GlobalInstallDeps, realGlobalInstall } from "../services/global-install.ts";
import { hasProfileFile, type InitResult, initSetup, moveLegacy } from "../services/setup.ts";
import { activeName } from "../services/profile-store.ts";
import { formatRefreshed, syncLines } from "./catalog-command.ts";
import { mark as markOf, refuseInRole } from "./cli-kit.ts";
import { formatReport } from "./doctor-command.ts";
import { mcpHandshake } from "./mcp/handshake.ts";
import type { State } from "./glyphs.ts";
import { mascot } from "./tui/theme.ts";
import { type Prompter, prompter } from "./prompt.ts";

/** What `init` prints last (spec §9.1): the plugin install commands, to paste into a terminal. */
export const PLUGIN_STEPS = [
  "Install the Claude Code plugin:",
  "  claude plugin marketplace add 47vigen/catherd",
  "  claude plugin install catherd@catherd",
  "Then start a new Claude Code session, so it loads the plugin and the catherd agents.",
];

/** Spec §9.3: the full mascot greets `init` (and the TUI's empty states), nowhere else. */
export function welcomeLines(version: string): string[] {
  const [ears, face, paws] = mascot("good");
  return [ears, `${face}  catherd ${version}`, `${paws}  herds your coding agents`, ""];
}

/**
 * The Jev key step. It never stops `init` (Ruling 11): a key that cannot be saved, say because
 * credentials.json is unparsable, is reported with its fix and setup goes on.
 */
export async function jevStep(
  ask: Prompter | null,
  d: { testJevKey?: (key: string) => Promise<boolean>; saveJevKey?: (key: string) => void } = {},
  plain = false,
): Promise<void> {
  const mark = (state: State) => markOf(state, plain);
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    ask?.skip?.();
    return console.log(`${mark("ok")} Jev: using TYPESAFE_API_KEY`);
  }
  if (jevKey()) {
    ask?.skip?.();
    return console.log(`${mark("ok")} Jev: using the saved key`);
  }
  const key = ask ? await ask.secret("TypeSafe API key for Jev (optional; Enter skips): ") : "";
  if (!key)
    return console.log(
      `- Jev: no key; routing uses each lane's Kind and Difficulty (add one later with catherd init)`,
    );
  if (!(await (d.testJevKey ?? testJevKey)(key).catch(() => false)))
    return console.log(`${mark("warn")} Jev: the key did not answer, so it was not saved`);
  try {
    (d.saveJevKey ?? saveJevKey)(key);
    console.log(`${mark("ok")} Jev: the key answers; saved with mode 600`);
  } catch (e) {
    const message = errorMessage(e).split("\n").join(" ");
    console.log(`${mark("warn")} Jev: could not save the key: ${message}`);
    if (isCatherdError(e) && e.fix) console.log(`    fix: ${e.fix}`);
  }
}

/**
 * Spec 1.2 §9: the Artificial Analysis key step, after Jev's. ARTIFICIAL_ANALYSIS_API_KEY wins, else the saved
 * key, else a prompt (Enter skips). A typed key is tested with one request: a 200 saves it, a 401 does not,
 * and a key that cannot be checked (no network) is not saved either. It never stops `init`.
 */
export async function aaStep(
  ask: Prompter | null,
  d: {
    testAaKey?: (key: string) => Promise<{ result: "ok" | "refused" | "unchecked"; error?: string }>;
    saveAaKey?: (key: string) => void;
  } = {},
  plain = false,
): Promise<void> {
  const mark = (state: State) => markOf(state, plain);
  if (process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim()) {
    ask?.skip?.();
    return console.log(`${mark("ok")} Artificial Analysis: using ARTIFICIAL_ANALYSIS_API_KEY`);
  }
  if (aaKey()) {
    ask?.skip?.();
    return console.log(`${mark("ok")} Artificial Analysis: using the saved key`);
  }
  const key = ask ? await ask.secret("Artificial Analysis API key (optional; Enter skips): ") : "";
  if (!key)
    return console.log(
      "- Artificial Analysis: no key; scores come from the keyless sources (add one later with catherd init)",
    );
  const t = await (d.testAaKey ?? testAaKey)(key).catch((e: unknown) => ({
    result: "unchecked" as const,
    error: errorMessage(e),
  }));
  if (t.result === "refused")
    return console.log(`${mark("warn")} Artificial Analysis: the key was refused (401), so it was not saved`);
  if (t.result === "unchecked")
    return console.log(
      `${mark("warn")} Artificial Analysis: the key could not be checked (${t.error ?? "no answer"}), so it was not saved; run catherd init again to retry`,
    );
  try {
    (d.saveAaKey ?? saveAaKey)(key);
    console.log(`${mark("ok")} Artificial Analysis: the key answers; saved with mode 600`);
  } catch (e) {
    console.log(
      `${mark("warn")} Artificial Analysis: could not save the key: ${errorMessage(e).split("\n").join(" ")}`,
    );
    if (isCatherdError(e) && e.fix) console.log(`    fix: ${e.fix}`);
  }
}

/**
 * Spec 1.2 §9: `init` syncs the public sources in the foreground, after the keys. It never stops `init`;
 * CATHERD_NO_SYNC=1 skips it.
 */
export async function syncStep(o: { plain?: boolean; sync?: () => Promise<SyncReport> } = {}): Promise<void> {
  const plain = o.plain === true;
  if (process.env.CATHERD_NO_SYNC === "1")
    return console.log("- sources: not synced (CATHERD_NO_SYNC=1); catherd catalog sync fetches them");
  console.log("syncing the public model sources…");
  try {
    for (const l of syncLines(await (o.sync ?? (() => syncSources()))(), plain)) console.log(l);
  } catch (e) {
    console.log(`${markOf("warn", plain)} sources: ${errorMessage(e).split("\n").join(" ")}`);
    console.log("    fix: catherd catalog sync");
  }
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

/** Spec §8 `catherd init [--no-input]`: first-run setup without the TUI (plan 6 adds the TUI wizard). */
export const initCommand = defineCommand({
  meta: {
    name: "init",
    description:
      "First run: the global catherd command, the Jev key, the Artificial Analysis key, a sync of the public model sources, the default profile, its agents, and a readiness report. Piped, it reads the answers from stdin one per line, a line per question even when this machine skips it (the Jev key, the Artificial Analysis key, the profile, whether to replace it), and waits for stdin to close; --no-input asks nothing",
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
      await jevStep(ask, {}, plain);
      await aaStep(ask, {}, plain);
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
      for (const l of terminalHost(args.host).host === "claude-code" ? PLUGIN_STEPS : []) console.log(l);
    } finally {
      ask?.close();
    }
  },
});
