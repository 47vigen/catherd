import {
  Ban,
  Code,
  CodeCommit,
  CodeMerge,
  Compass,
  Eye,
  FileText,
  Flag,
  Hourglass,
  ListCheck,
  Play,
  Rocket,
  Route,
  ScalesBalanced,
  SealCheck,
  ShieldCheck,
} from "@gravity-ui/icons";
import type { ComponentType, SVGProps } from "react";

import type { RunNode } from "../../../../client";

export type Icon = ComponentType<SVGProps<SVGSVGElement>>;
export type Kind = RunNode["kind"];
export type Status = RunNode["status"];
export type Tone = "running" | "success" | "danger" | "warning" | "muted";

export const KIND_ICON: Record<Kind, Icon> = {
  start: Play,
  architect: Compass,
  later: Hourglass,
  route: Route,
  preflight: ShieldCheck,
  lane: Code,
  check: ListCheck,
  commit: CodeCommit,
  review: Eye,
  verify: SealCheck,
  integrate: CodeMerge,
  land: Rocket,
  judge: ScalesBalanced,
  report: FileText,
  end: Flag,
};

export const STATUS_TONE: Record<Status, Tone> = {
  pending: "muted",
  running: "running",
  done: "success",
  failed: "danger",
  parked: "warning",
  skipped: "muted",
  cancelled: "muted",
};

export const STATUS_LABEL: Record<Status, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  failed: "Failed",
  parked: "Waiting for you",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

// A kind that builds, checks or lands in rounds: a failed check starts a fix round and adds an attempt.
const ROUNDED = new Set<Kind>(["lane", "check", "commit", "review", "verify"]);

/** How many rounds a step has had (a failover re-runs a round, so it does not count). */
export function roundsOf(n: RunNode): number {
  return ROUNDED.has(n.kind) ? n.attempts.filter((a) => a.kind !== "event" && !a.failoverFrom).length : 0;
}

export interface NodeView {
  icon: Icon;
  tone: Tone;
  /** "Question" while the step waits for the owner, else "round <n>" once there is more than one round. */
  badge: string | null;
  /** Pending and skipped steps are drawn quiet. */
  muted: boolean;
}

export function nodeView(n: RunNode): NodeView {
  const rounds = roundsOf(n);
  return {
    icon: n.status === "cancelled" ? Ban : KIND_ICON[n.kind],
    tone: STATUS_TONE[n.status],
    badge: n.status === "parked" ? "Question" : rounds > 1 ? `round ${rounds}` : null,
    muted: n.status === "pending" || n.status === "skipped",
  };
}

/** `backend:model#effort`, each part optional after the backend. */
export function parseRung(rung: string): { backend: string; model: string; effort: string | null } {
  const [head = "", effort] = rung.split("#");
  const i = head.indexOf(":");
  return { backend: i < 0 ? head : head.slice(0, i), model: i < 0 ? "" : head.slice(i + 1), effort: effort ?? null };
}

/** "46s", "2m 05s", "1h 03m". */
export function formatDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Seconds a step took (or has taken so far); null before it started. */
export function nodeSecs(n: RunNode, nowMs: number): number | null {
  if (!n.startedAt) return null;
  const start = Date.parse(n.startedAt);
  const end = n.endedAt ? Date.parse(n.endedAt) : n.status === "running" ? nowMs : Number.NaN;
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, (end - start) / 1000);
}

const ACRONYM = new Set(["gpt", "glm"]);

/** A model id as people say it: `claude-opus-5-5` is "Claude Opus 5.5", `gpt-6.1-sol` is "GPT-6.1 Sol". */
export function modelName(id: string): string {
  const out: string[] = [];
  for (const part of id.split(/[-_]/).filter(Boolean)) {
    const prev = out.at(-1);
    if (prev !== undefined && /^\d+(\.\d+)*$/.test(part)) {
      // A version after a version is its minor ("5-5" is 5.5); after an acronym it joins with a dash (GPT-6).
      if (/\d$/.test(prev)) out[out.length - 1] = `${prev}.${part}`;
      else if (ACRONYM.has(prev.toLowerCase())) out[out.length - 1] = `${prev}-${part}`;
      else out.push(part);
    } else out.push(ACRONYM.has(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1));
  }
  return out.join(" ");
}

/** A step's title inside its milestone's box, which already names the milestone: "M1 review" reads "Review". */
export function shortTitle(n: RunNode): string {
  // A check sits right after its lane's card, which names the lane.
  if (n.kind === "check") return "Fast check";
  if (n.kind === "start") return "Start";
  const t = n.milestone && n.title.startsWith(`${n.milestone} `) ? n.title.slice(n.milestone.length + 1) : n.title;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The step's own line when it says more than its status word ("Done" under a done step says nothing). */
export function nowLine(n: RunNode): string | null {
  const t = n.now.trim();
  return t === "" || t.toLowerCase() === STATUS_LABEL[n.status].toLowerCase() ? null : t;
}

/** One tone for a set of steps: the most urgent wins, and a set is done only when every step is. */
export function toneOf(nodes: RunNode[]): Tone {
  const has = (s: Status) => nodes.some((n) => n.status === s);
  if (has("failed")) return "danger";
  if (has("parked")) return "warning";
  if (has("running")) return "running";
  if (nodes.length > 0 && nodes.every((n) => n.status === "done" || n.status === "skipped")) return "success";
  return "muted";
}
