import type { DiscoveredModel } from "../backend.ts";

/** A model's efforts and context as the catalog ships them for grok (`on.grok`). */
export type ShippedGrok = Record<string, { efforts: string[]; context: number | null }>;

export interface GrokModels {
  /** null when `grok models` printed none of its auth lines */
  loggedIn: boolean | null;
  /** how: a Grok login (SuperGrok, X Premium+) or `XAI_API_KEY` */
  login?: "Grok" | "API key";
  defaultModel: string | null;
  models: DiscoveredModel[];
}

/**
 * `grok models` (research §3.4 [run]): an auth line first ("You are logged in with …", "You are using
 * XAI_API_KEY.", "You are not authenticated."), `Default model: <id>`, then `Available models:` with
 * `  * <id> (default)` or `  - <id>` lines. It lists no efforts: they come from the catalog's `on.grok`
 * (spec 1.3 §5.2), and a model the catalog lacks lists none.
 */
export function parseGrokModels(text: string, shipped: ShippedGrok = {}): GrokModels {
  const login = /You are using XAI_API_KEY/.test(text)
    ? "API key"
    : /You are logged in with/.test(text)
      ? "Grok"
      : undefined;
  const loggedIn = login ? true : /You are not authenticated/.test(text) ? false : null;
  const at = text.indexOf("Available models:");
  const ids =
    at === -1
      ? []
      : text
          .slice(at)
          .split("\n")
          .map((l) => /^\s*[*-]\s+(\S+)/.exec(l)?.[1])
          .filter((id): id is string => id !== undefined);
  return {
    loggedIn,
    ...(login ? { login } : {}),
    defaultModel: /Default model:\s*(\S+)/.exec(text)?.[1] ?? null,
    models: ids.map((id) => ({
      id,
      efforts: [...(shipped[id]?.efforts ?? [])],
      context: shipped[id]?.context ?? null,
      imageIn: false,
    })),
  };
}
