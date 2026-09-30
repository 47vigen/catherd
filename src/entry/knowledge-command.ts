import { resolve } from "node:path";
import { defineCommand } from "citty";
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

/** What past runs of a repo learned, which the read_knowledge tool gives every new run (spec §4.7). */
export const knowledgeCommand = defineCommand({
  meta: { name: "knowledge", description: "What catherd knows about a repo: show, add or path" },
  subCommands: { show, add, path },
});
