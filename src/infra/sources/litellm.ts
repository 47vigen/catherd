import { z } from "zod";
import { type SourceTransport, sourceGet } from "./http.ts";
import { perMillion } from "./openrouter-models.ts";
import { num } from "./rows.ts";

/** Spec 1.2 §3.1: price and effort support, a cross-check only (MIT). */
export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const fetchLiteLlm = async (t: SourceTransport = {}): Promise<unknown> =>
  (await sourceGet(LITELLM_URL, t)).json();

/** The efforts LiteLLM flags per model (`supports_<effort>_reasoning_effort`). */
export const LITELLM_EFFORTS = ["none", "minimal", "low", "xhigh", "max"] as const;

export interface LiteLlmModel {
  id: string;
  provider: string;
  /** dollars per million tokens */
  price: { input: number; output: number; cached: number | null } | null;
  context: number | null;
  /** effort → whether LiteLLM says the model supports it; absent when it does not say */
  efforts: Partial<Record<(typeof LITELLM_EFFORTS)[number], boolean>>;
}

/** Spec 1.2 §3.5: the vendors' own APIs, whose prices the catalog's are. */
const FIRST_PARTY = new Set(["openai", "anthropic"]);

const EntrySchema = z.looseObject({ litellm_provider: z.string() });

/** The first-party entries of LiteLLM's price file: an OpenAI or Anthropic provider, a key with no `/`. */
export function parseLiteLlm(raw: unknown): LiteLlmModel[] {
  if (!raw || typeof raw !== "object") return [];
  const out: LiteLlmModel[] = [];
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = EntrySchema.safeParse(v);
    if (!e.success || !FIRST_PARTY.has(e.data.litellm_provider) || id.includes("/")) continue;
    const entry = e.data as Record<string, unknown>;
    const input = perMillion(entry.input_cost_per_token);
    const output = perMillion(entry.output_cost_per_token);
    const efforts: LiteLlmModel["efforts"] = {};
    for (const effort of LITELLM_EFFORTS) {
      const flag = entry[`supports_${effort}_reasoning_effort`];
      if (typeof flag === "boolean") efforts[effort] = flag;
    }
    out.push({
      id,
      provider: e.data.litellm_provider,
      price:
        input !== null && output !== null
          ? { input, output, cached: perMillion(entry.cache_read_input_token_cost) }
          : null,
      context: num(entry.max_input_tokens),
      efforts,
    });
  }
  return out;
}
