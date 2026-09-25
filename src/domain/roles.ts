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

/**
 * Spec D3/§6.2: a role's Claude rungs run as native Claude Code subagents (`claude:`) or headless
 * (`claude-code:`). The profile will choose per role (plan 5); until then architect and verifier are
 * native, the defaults the spec names, and every other role runs headless.
 */
export const NATIVE_CLAUDE_ROLES: readonly Role[] = ["architect", "verifier"];

export const claudeBackendFor = (role: Role): "claude" | "claude-code" =>
  NATIVE_CLAUDE_ROLES.includes(role) ? "claude" : "claude-code";
