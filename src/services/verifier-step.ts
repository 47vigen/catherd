import { liveSessionFile, readSessionFiles, type SessionFile } from "../infra/claude-session.ts";
import { readJsonl } from "../infra/store.ts";
import { gatesFile, latestVerifierStep, type VerifierStep } from "./gate-service.ts";
import { readAgentRuns, readRecords, type Run } from "./run-store.ts";
import { runOwner } from "./sessions.ts";

/** What ended a verifier step (plan 22: a step nothing ends shows as live forever). */
export type StepClosedBy = "gate_pass" | "agent-run" | "record" | "owner-gone";

export interface VerifierStepView extends VerifierStep {
  /** seconds since the step began */
  secs: number;
  open: boolean;
  closedBy: StepClosedBy | null;
}

/**
 * Plan 22: the verifier's latest step with its age, closed by the first evidence after it: a `gate_pass` of its
 * item in this run, a native verifier's `record_agent_run`, a verifier dispatch's record, or its owner session
 * gone (another session took the run since, or the owner's Claude Code session no longer runs). A Codex owner
 * that still holds the run has no liveness to read: its step stays open until other evidence ends it.
 */
export function verifierStepView(
  run: Run,
  now: number,
  files: () => SessionFile[] = readSessionFiles,
): VerifierStepView | null {
  const step = latestVerifierStep(run);
  if (!step) return null;
  const at = Date.parse(step.at) || 0;
  const after = (t: string | undefined) => (Date.parse(t ?? "") || 0) >= at;
  const passed = readJsonl<{ run?: unknown; item?: unknown; at?: string }>(
    gatesFile(run.meta.repo),
  ).rows.some((p) => p?.run === run.id && p.item === step.item && after(p.at));
  const owner = runOwner(run);
  const closedBy: StepClosedBy | null = passed
    ? "gate_pass"
    : readAgentRuns(run).some((a) => a.role === "verifier" && after(a.at))
      ? "agent-run"
      : readRecords(run).records.some((r) => r.role === "verifier" && after(r.endedAt))
        ? "record"
        : owner &&
            ((Date.parse(owner.since) || 0) > at ||
              (owner.host === "claude-code" && liveSessionFile(owner.sessionId, files()) === null))
          ? "owner-gone"
          : null;
  return { ...step, secs: Math.max(0, Math.floor((now - at) / 1000)), open: closedBy === null, closedBy };
}
