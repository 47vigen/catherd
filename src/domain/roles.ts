import type { Access } from "./record.ts";

export const ROLES = [
  "architect",
  "verifier",
  "worker",
  "reviewer",
  "ui-reviewer",
  "artist",
  "writer",
  "researcher",
] as const;
export type Role = (typeof ROLES)[number];

/** Spec §7.1: the access mode a role runs with unless its profile says otherwise. */
export const DEFAULT_ACCESS: Record<Role, Access> = {
  architect: "read-only",
  reviewer: "read-only",
  researcher: "read-only",
  worker: "workspace-write",
  writer: "workspace-write",
  artist: "workspace-write",
  verifier: "full",
  "ui-reviewer": "full",
};
