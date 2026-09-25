import { CatherdError } from "./errors.ts";

/** Run, role, lane and dispatch ids end up in file names: no separator, no leading dot or dash. */
export const ID_PATTERN = /^[A-Za-z0-9][\w.-]{0,127}$/;

export function assertId(kind: string, value: string): string {
  if (!ID_PATTERN.test(value) || value.includes(".."))
    throw new CatherdError("E_ADMIT_ID", `bad ${kind} id "${value}"`, {
      fix: "use letters, digits, '.', '_' and '-', starting with a letter or digit",
    });
  return value;
}

/** `claude` is the native Claude Code subagent path (no process); the rest are adapters. */
export const RUNG_BACKENDS = ["codex", "claude-code", "opencode", "cursor", "grok", "claude"] as const;
export type RungBackend = (typeof RUNG_BACKENDS)[number];

export interface Rung {
  backend: RungBackend;
  model: string;
  effort: string;
}

export function parseRung(s: string): Rung {
  const colon = s.indexOf(":");
  const hash = s.lastIndexOf("#");
  const backend = s.slice(0, Math.max(colon, 0));
  const model = s.slice(colon + 1, hash);
  const effort = s.slice(hash + 1);
  if (colon < 1 || hash <= colon + 1 || !effort || !(RUNG_BACKENDS as readonly string[]).includes(backend))
    throw new CatherdError("E_ADMIT_RUNG", `bad rung "${s}"`, {
      fix: "write it as <backend>:<model>#<effort>",
    });
  return { backend: backend as RungBackend, model, effort };
}

export const formatRung = (r: Rung): string => `${r.backend}:${r.model}#${r.effort}`;

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 10 chars of millisecond time, then 16 random, so ids sort by creation. */
export function newDispatchId(now: number = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = B32.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (const b of bytes) rand += B32.charAt(b % 32);
  return time + rand;
}
