import { defineCommand } from "citty";
import { assertProfileName } from "../domain/profile.ts";
import { isCatherdError } from "../domain/errors.ts";
import { configDir } from "../infra/paths.ts";
import { VERSION } from "../infra/version.ts";
import { doctor } from "../services/doctor.ts";
import { jevKey, saveJevKey, testJevKey } from "../services/jev-service.ts";
import { hasProfileFile, type InitResult, initSetup, moveLegacy } from "../services/setup.ts";
import { formatRefreshed } from "./catalog-command.ts";
import { mark } from "./cli-kit.ts";
import { formatReport } from "./doctor-command.ts";
import { mcpHandshake } from "./mcp/handshake.ts";
import { type Prompter, prompter } from "./prompt.ts";

/** What `init` prints last (spec §9.1): the plugin install commands, to paste into a terminal. */
export const PLUGIN_STEPS = [
  "Install the Claude Code plugin:",
  "  claude plugin marketplace add 47vigen/catherd",
  "  claude plugin install catherd@catherd",
  "Then start a new Claude Code session, so it loads the plugin and the catherd agents.",
];

/**
 * The Jev key step. It never stops `init` (Ruling 11): a key that cannot be saved, say because
 * credentials.json is unparsable, is reported with its fix and setup goes on.
 */
export async function jevStep(
  ask: Prompter | null,
  d: { testJevKey?: (key: string) => Promise<boolean>; saveJevKey?: (key: string) => void } = {},
): Promise<void> {
  if (process.env.TYPESAFE_API_KEY?.trim()) return console.log(`${mark("ok")} Jev: using TYPESAFE_API_KEY`);
  if (jevKey()) return console.log(`${mark("ok")} Jev: using the saved key`);
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
    const message = (e instanceof Error ? e.message : String(e)).split("\n").join(" ");
    console.log(`${mark("warn")} Jev: could not save the key: ${message}`);
    if (isCatherdError(e) && e.fix) console.log(`    fix: ${e.fix}`);
  }
}

/** What happened to the profile: written, kept, or (when the defaults do not validate here) why not. */
export function profileLines(r: InitResult): string[] {
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
      "First run: the Jev key, the default profile, its agents, and a readiness report. Piped, it reads the answers from stdin one per line and waits for stdin to close; --no-input asks nothing",
  },
  args: {
    // citty reads --no-input as input: false
    input: {
      type: "boolean",
      default: true,
      description: "ask questions (piped: one answer per line, read once stdin closes)",
      negativeDescription: "ask nothing: keep what exists, else write the defaults",
    },
    profile: { type: "string", description: "the profile to set up and make active (default: default)" },
  },
  async run({ args }) {
    // a bad --profile is refused before any question is asked
    if (args.profile !== undefined) assertProfileName(args.profile);
    const ask = args.input === false ? null : await prompter();
    try {
      console.log(`catherd ${VERSION}: setting up in ${configDir()}`);
      await jevStep(ask);
      const name = assertProfileName(
        args.profile ?? (ask ? (await ask.ask("Profile to set up [default]: ")) || "default" : "default"),
      );
      // 0.x files go first, so a legacy profile about to be moved aside is never asked about
      const moved = moveLegacy();
      const overwrite =
        ask !== null &&
        hasProfileFile(name) &&
        /^y(es)?$/i.test(await ask.ask(`Replace profile ${name} with the default profile? [y/N] `));
      const r = await initSetup({ profile: name, overwrite });
      for (const f of [...moved, ...r.moved]) console.log(`${mark("ok")} moved a 0.x file aside: ${f}`);
      for (const l of profileLines(r)) console.log(l);
      if (r.synced?.linked.length)
        console.log(`${mark("ok")} Claude agents linked: ${r.synced.linked.join(", ")}`);
      for (const x of r.refreshed) console.log(formatRefreshed(x));
      console.log("");
      const report = await doctor({
        bunVersion: Bun.version,
        version: VERSION,
        handshake: () => mcpHandshake(),
      });
      for (const l of formatReport(report)) console.log(l);
      console.log("");
      for (const l of PLUGIN_STEPS) console.log(l);
    } finally {
      ask?.close();
    }
  },
});
