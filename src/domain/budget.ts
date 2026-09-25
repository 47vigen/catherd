export interface Budget {
  minutes?: number;
  tokens?: number;
  usd?: number;
}

export interface Spend {
  minutes: number;
  tokens: number;
  usd: number;
}

export interface BudgetStatus {
  /** the highest spent/cap ratio over the caps the profile sets; ≥ 1 means spent */
  fraction: number;
  minutes?: { spent: number; cap: number };
  tokens?: { spent: number; cap: number };
  usd?: { spent: number; cap: number };
}

/** Spec §4.6: from this fraction on, `route` starts at the cheapest rung that clears the bar. */
export const BUDGET_CHEAP_AT = 0.8;

/** null when the profile sets no cap. */
export function budgetStatus(spend: Spend, budget: Budget): BudgetStatus | null {
  const b: BudgetStatus = { fraction: 0 };
  let capped = false;
  for (const key of ["minutes", "tokens", "usd"] as const) {
    const cap = budget[key];
    if (cap === undefined) continue;
    capped = true;
    const spent = spend[key];
    b[key] = { spent, cap };
    b.fraction = Math.max(b.fraction, cap > 0 ? spent / cap : spent > 0 ? 1 : 0);
  }
  return capped ? b : null;
}

export function formatBudget(b: BudgetStatus): string {
  const parts: string[] = [];
  if (b.minutes) parts.push(`${Math.round(b.minutes.spent)}/${b.minutes.cap} min`);
  if (b.tokens) parts.push(`${b.tokens.spent}/${b.tokens.cap} tokens`);
  if (b.usd) parts.push(`$${b.usd.spent.toFixed(2)}/$${b.usd.cap.toFixed(2)}`);
  return `${parts.join(" · ")} (${Math.round(b.fraction * 100)}%)`;
}
