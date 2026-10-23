import type { SetupView } from "../../../../client";

export type Role = SetupView["roles"][number];
export type Access = Role["access"];

export const ROLE_NAME: Record<Role["role"], string> = {
  architect: "Architect",
  verifier: "Verifier",
  worker: "Worker",
  reviewer: "Reviewer",
  "ui-reviewer": "UI reviewer",
  artist: "Artist",
  writer: "Writer",
  researcher: "Researcher",
  judge: "Judge",
};

export const ROLE_MEANING: Record<Role["role"], string> = {
  architect: "Plans the run and splits it into milestones.",
  verifier: "Checks each finished lane against the plan.",
  worker: "Writes the code of a lane.",
  reviewer: "Reads a lane's changes and sends back what is wrong.",
  "ui-reviewer": "Looks at the screens a change touches.",
  artist: "Makes images and other visual assets.",
  writer: "Writes the docs and the words in a change.",
  researcher: "Looks things up and reports what it found.",
  judge: "Decides a question for the run, such as how to handle a failure.",
};

export const ACCESS: readonly { id: Access; label: string; consequence: string }[] = [
  { id: "read-only", label: "Read only", consequence: "It can read the repo, but it cannot change any file." },
  {
    id: "workspace-write",
    label: "Workspace",
    consequence: "It can change files inside the repo, and nothing outside it.",
  },
  { id: "full", label: "Full access", consequence: "It can change any file and run any command on this machine." },
];

export const accessLabel = (a: Access): string => ACCESS.find((x) => x.id === a)?.label ?? a;
