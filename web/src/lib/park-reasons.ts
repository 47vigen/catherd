import type { ParkedView } from "../client";

type Reason = ParkedView["reason"];

/** Why a unit stopped and waits for you, in plain words. */
export const REASON_TEXT: Record<Reason, string> = {
  needs_user: "A worker needs a decision only you can make before it can go on.",
  too_hard: "The task proved too hard for every open rung, so catherd stopped to ask.",
  provider_error: "The provider kept failing, so the work could not go on without you.",
  no_access: "A worker lacked the access it needs, such as a tool, a file or a network call.",
  check_broken: "The fast check itself is broken, so a pass or a fail would mean nothing.",
  out_of_scope: "The work needs a change outside what the plan allows this lane to touch.",
  environment: "The machine is not ready: a tool is missing or a service is not running.",
  preflight: "The preflight found a problem on the base tree before any worker started.",
  confirm: "catherd wants your word before it goes on with this step.",
  approval: "The plan is ready. Nothing is built until you approve it or ask for changes.",
  blocker: "A known issue blocks the milestone. Fix it, or land with the issue noted.",
  verifier: "The verifier could not decide whether the work meets the plan.",
  commit: "The milestone's changes could not be committed.",
  land: "The milestone could not be landed on the base branch.",
  budget: "The run reached its budget, so nothing new starts until you raise it.",
  judge: "A judge could not settle a question and passed it to you.",
  effect: "A step would change something outside the repository, so it waits for you.",
  push: "The branch is ready. Push it, or tell catherd it has been merged.",
  decision: "The decision model gave no usable answer. Answer with one of the listed rungs, or retry.",
  owner: "The architect asks you about production, a secret, an action that cannot be undone, or a stuck run.",
};

export interface QuickAnswer {
  label: string;
  /** What is sent as the answer; null means the text box supplies it, or a link is followed. */
  answer: string | null;
  href?: string;
}

const CONFIRM: QuickAnswer[] = [{ label: "Confirm and continue", answer: "confirmed" }];

/** Answers worth one click. Every other reason takes the text box only. */
export const QUICK_ANSWERS: Partial<Record<Reason, QuickAnswer[]>> = {
  approval: [
    { label: "Approve plan", answer: "approve" },
    { label: "Request changes", answer: null },
  ],
  push: [
    { label: "Push the branch", answer: "push" },
    { label: "It is merged", answer: "merged" },
  ],
  preflight: CONFIRM,
  confirm: CONFIRM,
  blocker: [{ label: "Land with the known issues", answer: "land with the known issues" }],
  budget: [
    { label: "Raise the budget", answer: null, href: "/setup?section=budget" },
    { label: "I raised it", answer: "budget raised" },
  ],
};
