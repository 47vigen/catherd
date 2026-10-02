import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import {
  pauseLine,
  pauseMachine,
  pauseWorkspace,
  resumeMachine,
  resumeWorkspace,
} from "../services/pause.ts";
import { JSON_ARG, printJson, refuseInRole } from "./cli-kit.ts";

/** Exactly one of --machine and --workspace: what a pause or resume covers. */
function scope(args: { machine?: boolean; workspace?: string }, usage: string): "machine" | string {
  if (args.machine === true && args.workspace === undefined) return "machine";
  if (args.machine !== true && args.workspace) return args.workspace;
  throw new CatherdError(
    "E_INPUT_INVALID",
    "name what to pause: --machine or --workspace <id>, one of them",
    {
      fix: usage,
    },
  );
}

const SCOPE_ARGS = {
  machine: { type: "boolean", description: "every run on this machine" },
  workspace: { type: "string", description: "every child of this workspace" },
} as const;

const PAUSE_USAGE = 'catherd pause --machine "the VPN takes the default route"';
const RESUME_USAGE = "catherd resume --machine";

/** Spec 1.5 "Group pause": one blocker, one pause, instead of a park per run and milestone. */
export const pauseCommand = defineCommand({
  meta: {
    name: "pause",
    description:
      "Pause every run on this machine (--machine) or in a workspace: dispatches are refused until resume",
  },
  args: {
    reason: { type: "positional", required: true, description: "why: what blocks the runs" },
    ...SCOPE_ARGS,
    ...JSON_ARG,
  },
  run({ args }) {
    refuseInRole(process.env, "catherd pause");
    const at = scope(args, PAUSE_USAGE);
    const r =
      at === "machine"
        ? pauseMachine(Date.now(), args.reason)
        : pauseWorkspace(Date.now(), { workspace: at, reason: args.reason });
    if (args.json) return printJson(r);
    console.log(pauseLine(r.pause));
  },
});

export const resumeCommand = defineCommand({
  meta: { name: "resume", description: "Lift a pause on this machine (--machine) or on a workspace" },
  args: { ...SCOPE_ARGS, ...JSON_ARG },
  run({ args }) {
    refuseInRole(process.env, "catherd resume");
    const at = scope(args, RESUME_USAGE);
    const r = at === "machine" ? resumeMachine(Date.now()) : resumeWorkspace(Date.now(), { workspace: at });
    if (args.json) return printJson(r);
    console.log(r.resumed ? `resumed: ${pauseLine(r.resumed)}` : "nothing was paused");
  },
});
