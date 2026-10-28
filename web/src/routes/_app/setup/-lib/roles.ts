import type { SetupView } from "../../../../client";

export type Role = SetupView["roles"][number];
export type Access = Role["access"];

export const ROLE_NAME: Record<Role["role"], string> = {
  architect: "Architect",
  verifier: "Verifier",
  worker: "Worker",
  reviewer: "Reviewer",
  artist: "Artist",
  writer: "Writer",
  researcher: "Researcher",
};

export const ROLE_MEANING: Record<Role["role"], string> = {
  architect: "Plans the run and splits it into milestones.",
  verifier: "Checks each finished lane against the plan.",
  worker: "Writes the code of a lane.",
  reviewer: "Reads a change, and its screens when asked, and reports what is wrong.",
  artist: "Makes images and other visual assets.",
  writer: "Writes the docs and the words in a change.",
  researcher: "Looks things up and reports what it found.",
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
