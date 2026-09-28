import { z } from "zod";
import { type SourceTransport, sourceGet } from "./http.ts";
import { num } from "./rows.ts";

/** Spec 1.2 §3.1: price and context cross-check; a model appears here the day it ships. */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export const fetchOpenRouterModels = async (t: SourceTransport = {}): Promise<unknown> =>
  (await sourceGet(OPENROUTER_MODELS_URL, t)).json();

export interface OpenRouterModel {
  /** `author/slug`, as the endpoints path takes it */
  id: string;
  context: number | null;
  /** dollars per million tokens */
  price: { input: number; output: number; cached: number | null } | null;
  efforts: string[] | null;
  defaultEffort: string | null;
}

const ModelSchema = z.looseObject({
  id: z.string(),
  context_length: z.unknown(),
  pricing: z
    .looseObject({ prompt: z.unknown(), completion: z.unknown(), input_cache_read: z.unknown() })
    .optional(),
  reasoning: z
    .looseObject({ supported_efforts: z.array(z.string()).optional(), default_effort: z.string().optional() })
    .optional(),
});

/** A per-token price (a number or decimal string) per million tokens, without float noise (0.000002 × 1e6). */
export const perMillion = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n * 1e12) / 1e6;
};

/** Every model of OpenRouter's `/models` answer; a malformed entry is skipped. */
export function parseOpenRouterModels(raw: unknown): OpenRouterModel[] {
  const data = (raw as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: OpenRouterModel[] = [];
  for (const entry of data) {
    const m = ModelSchema.safeParse(entry);
    if (!m.success) continue;
    const input = perMillion(m.data.pricing?.prompt);
    const output = perMillion(m.data.pricing?.completion);
    out.push({
      id: m.data.id,
      context: num(m.data.context_length),
      price:
        input !== null && output !== null
          ? { input, output, cached: perMillion(m.data.pricing?.input_cache_read) }
          : null,
      efforts: m.data.reasoning?.supported_efforts ?? null,
      defaultEffort: m.data.reasoning?.default_effort ?? null,
    });
  }
  return out;
}
