import { resolve } from "node:path";
import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { gateEnvLines, readGateEnv, removeGateEnv, setGateEnv } from "../services/gate-env.ts";
import { addKnowledge, knowledgeLines, knowledgePath, readKnowledge } from "../services/run-service.ts";
import { JSON_ARG, printJson } from "./cli-kit.ts";

/** `--repo`, else the repository the command runs in, as run_start and read_knowledge resolve it. */
const REPO_ARG = {
  repo: { type: "string", description: "any path inside the git repo (default: the one you are in)" },
} as const;
const repoOf = (repo: string | undefined): string => resolve(repo ?? process.cwd());

const show = defineCommand({
  meta: { name: "show", description: "Print what catherd knows about the repo (its knowledge.md)" },
  args: { ...REPO_ARG, ...JSON_ARG },
  async run({ args }) {
    if (args.json) return printJson(await knowledgeLines(repoOf(args.repo)));
    const text = await readKnowledge(repoOf(args.repo));
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  },
});

const add = defineCommand({
  meta: {
    name: "add",
    description: 'Append one fact to the repo\'s knowledge.md, marked "by hand"',
  },
  args: {
    line: { type: "positional", required: true, description: "the fact, on one line" },
    ...REPO_ARG,
  },
  async run({ args }) {
    console.log(await addKnowledge(repoOf(args.repo), args.line));
  },
});

const path = defineCommand({
  meta: { name: "path", description: "Print the path of the repo's knowledge.md (it may not exist yet)" },
  args: { ...REPO_ARG, ...JSON_ARG },
  async run({ args }) {
    const at = await knowledgePath(repoOf(args.repo));
    if (args.json) return printJson(at);
    console.log(at.path);
  },
});

/** `NAME=value` as name and value; null when it has no `=`. */
function assignment(raw: string): { name: string; value: string } | null {
  const eq = raw.indexOf("=");
  return eq > 0 ? { name: raw.slice(0, eq), value: raw.slice(eq + 1) } : null;
}

const envSet = defineCommand({
  meta: {
    name: "set",
    description:
      "Set one variable of the repo's gate environment, which the verifier and preflight run with: NAME=value, or NAME --from ENV_VAR for a secret (stored by reference, read when a role starts)",
  },
  args: {
    variable: { type: "positional", required: true, description: "NAME=value, or NAME with --from" },
    from: { type: "string", description: "the env var that holds the secret value" },
    ...REPO_ARG,
    ...JSON_ARG,
  },
  async run({ args }) {
    const set = assignment(args.variable);
    if (args.from !== undefined && set)
      throw new CatherdError("E_INPUT_INVALID", "pass NAME=value or NAME --from ENV_VAR, not both", {
        fix: "catherd knowledge env set DOCKER_HOST=unix:///var/run/docker.sock",
      });
    if (args.from === undefined && !set)
      throw new CatherdError("E_INPUT_INVALID", `"${args.variable}" has no value`, {
        fix: "catherd knowledge env set NAME=value, or catherd knowledge env set NAME --from ENV_VAR",
      });
    const r = set
      ? await setGateEnv(repoOf(args.repo), set.name, { value: set.value })
      : await setGateEnv(repoOf(args.repo), args.variable, { from: args.from as string });
    if (args.json) return printJson(r);
    for (const line of gateEnvLines(r.vars)) console.log(line);
  },
});

const envRm = defineCommand({
  meta: { name: "rm", description: "Remove one variable from the repo's gate environment" },
  args: { name: { type: "positional", required: true }, ...REPO_ARG, ...JSON_ARG },
  async run({ args }) {
    const r = await removeGateEnv(repoOf(args.repo), args.name);
    if (args.json) return printJson(r);
    for (const line of gateEnvLines(r.vars)) console.log(line);
  },
});

const envList = defineCommand({
  meta: { name: "list", description: "Print the repo's gate environment (a secret shows as $ENV_VAR)" },
  args: { ...REPO_ARG, ...JSON_ARG },
  async run({ args }) {
    const at = await knowledgePath(repoOf(args.repo));
    const vars = readGateEnv(at.repo);
    if (args.json) return printJson({ repo: at.repo, vars });
    const lines = gateEnvLines(vars);
    console.log(lines.length ? lines.join("\n") : "catherd: no gate environment set for this repo");
  },
});

/** Plan 23: the repo's gate environment, beside its knowledge.md. */
const env = defineCommand({
  meta: {
    name: "env",
    description: "The repo's gate environment, which the verifier and preflight run with: set, rm or list",
  },
  subCommands: { set: envSet, rm: envRm, list: envList },
});

/** What past runs of a repo learned, which the read_knowledge tool gives every new run (spec §4.7). */
export const knowledgeCommand = defineCommand({
  meta: {
    name: "knowledge",
    description: "What catherd knows about a repo: show, add or path, and its gate environment (env)",
  },
  subCommands: { show, add, path, env },
});
