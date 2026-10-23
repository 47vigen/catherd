import type { Attempt } from "../../../../client";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const usd = new Intl.NumberFormat("en", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

type Tokens = NonNullable<Attempt["tokens"]>;

/** Input plus output tokens: cached tokens are already part of the input. */
export const tokenTotal = (t: Tokens | null | undefined): number => (t ? t.input + t.output : 0);

export const formatTokens = (n: number): string => (n < 1000 ? String(n) : compact.format(n));

export const formatCost = (n: number | null | undefined): string => (n == null ? "–" : usd.format(n));

/** What a run has used so far: the sum over its dispatches; cost is null when no dispatch reported one. */
export function totalsOf(dispatches: Attempt[]): { tokens: number; costUsd: number | null } {
  let costUsd: number | null = null;
  let tokens = 0;
  for (const d of dispatches) {
    tokens += tokenTotal(d.tokens);
    if (d.costUsd != null) costUsd = (costUsd ?? 0) + d.costUsd;
  }
  return { tokens, costUsd };
}
