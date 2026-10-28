import type { Access } from "./record.ts";

export const ROLES = [
  "architect",
  "verifier",
  "worker",
  "reviewer",
  "artist",
  "writer",
  "researcher",
] as const;
export type Role = (typeof ROLES)[number];

/** Spec §7.1: the access mode a role runs with unless its profile says otherwise. */
export const DEFAULT_ACCESS: Record<Role, Access> = {
  architect: "workspace-write",
  // plan 51: the ui-reviewer's screenshots are the reviewer's now, and they need a browser and a file
  reviewer: "full",
  researcher: "read-only",
  worker: "workspace-write",
  writer: "workspace-write",
  artist: "workspace-write",
  verifier: "full",
};

/** Plan 51 (spec D16): a role an earlier build ran that this one reads as another: its UI reviews were reviews. */
export const readRole = (role: unknown): unknown => (role === "ui-reviewer" ? "reviewer" : role);
