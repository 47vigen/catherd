import { resolve } from "node:path";
import { defineCommand } from "citty";
import { inspectWorkspace, workspaceStatus } from "../services/workspace-service.ts";
import { JSON_ARG, printJson } from "./cli-kit.ts";
import { defaultDeps } from "./deps.ts";

const inspect = defineCommand({
  meta: { name: "inspect", description: "Read the explicit repositories in a workspace manifest" },
  args: {
    root: { type: "positional", description: "workspace root (default: current directory)" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const view = await inspectWorkspace(resolve(args.root ?? process.cwd()));
    if (args.json) return printJson(view);
    console.log(view.root);
    for (const [name, path] of Object.entries(view.repos)) console.log(`${name}: ${path}`);
  },
});

const status = defineCommand({
  meta: { name: "status", description: "Read a workspace run's children, dependencies and budget" },
  args: {
    workspace: { type: "positional", required: true, description: "workspace run id" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const view = await workspaceStatus(defaultDeps(), args.workspace);
    if (args.json) return printJson(view);
    console.log(`${view.workspace.id}: ${view.workspace.title}`);
    for (const step of view.steps) {
      const blocked = step.blockedBy.length ? ` (waiting for ${step.blockedBy.join(", ")})` : "";
      console.log(`${step.id}: ${step.repo} ${step.state}${step.run ? ` ${step.run}` : ""}${blocked}`);
    }
    console.log(
      `spend: ${view.spend.tokens} tokens, ${view.spend.minutes.toFixed(2)} min, $${view.spend.usd.toFixed(2)}`,
    );
  },
});

export const workspaceCommand = defineCommand({
  meta: { name: "workspace", description: "Inspect workspace members and coordinated runs" },
  subCommands: { inspect, status },
});
