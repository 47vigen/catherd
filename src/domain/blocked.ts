/** Why a role stopped without finishing (spec 2.0 decision 3); plan 30b maps each to a rule, plan 30 lists them. */
export const BLOCKED_REASONS = [
  "needs_user",
  "too_hard",
  "provider_error",
  "no_access",
  "check_broken",
  "out_of_scope",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];
