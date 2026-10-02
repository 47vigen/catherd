import { protocolView } from "./protocol.ts";
import { type OpenQuestion, openQuestions } from "./questions.ts";
import type { Run } from "./run-store.ts";
import { type Notes, readNotes } from "./state.ts";
import { verifierStepView, type VerifierStepView } from "./verifier-step.ts";

// Spec 1.1 §8, §7 and §10: what a session re-entering a run needs first, as peek returns it: the owner questions still open, the protocol's next step with its checklist,
// and the verifier's latest step.

export interface Reentry {
  questions: OpenQuestion[];
  protocol: { next: string; checklist: string[] };
  verifier: VerifierStepView | null;
}

/** `notes`: state.json as the caller already read it (peek), so it is read once. */
export function reentry(run: Run, now?: number, notes: Notes = readNotes(run)): Reentry {
  return {
    questions: openQuestions(run),
    protocol: protocolView(run, notes.parked ?? [], now),
    verifier: verifierStepView(run, now ?? Date.now()),
  };
}
