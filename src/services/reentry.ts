import { protocolView } from "./protocol.ts";
import { type OpenQuestion, openQuestions } from "./questions.ts";
import type { Run } from "./run-store.ts";
import { readNotes } from "./state.ts";
import { verifierStepView, type VerifierStepView } from "./verifier-step.ts";

// Spec 1.1 §8, §7 and §10: what a session re-entering a run needs first, as peek returns it: the owner questions still open, the protocol's next step with its checklist,
// and the verifier's latest step.

export interface Reentry {
  questions: OpenQuestion[];
  protocol: { next: string; checklist: string[] };
  verifier: VerifierStepView | null;
}

export function reentry(run: Run, now?: number): Reentry {
  return {
    questions: openQuestions(run),
    protocol: protocolView(run, readNotes(run).parked ?? [], now),
    verifier: verifierStepView(run, now ?? Date.now()),
  };
}
