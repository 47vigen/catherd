/** One source for every concept the panel names; `Term` shows these as a tooltip wherever the word is a label. */
export const TERMS = [
  "run",
  "milestone",
  "lane",
  "rung",
  "ladder",
  "effort",
  "round",
  "failover",
  "fast check",
  "verifier",
  "judge",
  "A-line",
  "access level",
] as const;

export type GlossaryTerm = (typeof TERMS)[number];

/** One plain sentence each, at most 140 characters. */
export const GLOSSARY: Record<GlossaryTerm, string> = {
  run: "One task you gave catherd, followed from its plan to its final report.",
  milestone: "A part of a run that is planned, built, checked and landed as one change.",
  lane: "A slice of a milestone that one worker builds on its own files.",
  rung: "One choice of backend, model and effort that a role can run on.",
  ladder: "A role's rungs, lowest first. A task starts on the first and climbs one after a failure.",
  effort: "How hard the model is asked to think. Higher effort is slower and costs more.",
  round: "One pass of build then check. A failed check starts a fix round.",
  failover: "Switching to a stand-in rung when the first one hits a provider limit.",
  "fast check": "The quick lint and type check a lane must pass before the full verification.",
  verifier: "The role that checks a finished lane against the plan and the rules.",
  judge: "A role of an earlier run that decided a question for it, such as how to handle a failure.",
  "A-line": "One acceptance line: a testable requirement the finished run must meet.",
  "access level": "How much a role may read, write and run on this machine.",
};
