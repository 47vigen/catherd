import { z } from "zod";
import { type SourceTransport, sourceGet } from "./http.ts";
import { num } from "./rows.ts";

/** Spec 1.2 §3.1: efforts, context, output limit, price, tool calling, modalities, release date (MIT). */
export const MODELS_DEV_URL = "https://models.dev/api.json";

export const fetchModelsDev = async (t: SourceTransport = {}): Promise<unknown> =>
  (await sourceGet(MODELS_DEV_URL, t)).json();

/** What catherd reads of one models.dev model; each field null when the source does not say. */
export interface ModelFacts {
  efforts: string[] | null;
  context: number | null;
  output: number | null;
  /** dollars per million tokens */
  price: { input: number; cached: number; output: number } | null;
  toolUse: boolean | null;
  imageIn: boolean | null;
  reasoning: boolean | null;
  releaseDate: string | null;
}

const ModelSchema = z.looseObject({
  reasoning: z.boolean().optional(),
  reasoning_options: z
    .array(z.looseObject({ type: z.string(), values: z.array(z.string()).optional() }))
    .optional(),
  tool_call: z.boolean().optional(),
  release_date: z.string().optional(),
  modalities: z.looseObject({ input: z.array(z.string()).optional() }).optional(),
  limit: z.looseObject({ context: z.unknown(), output: z.unknown() }).optional(),
  cost: z.looseObject({ input: z.unknown(), output: z.unknown(), cache_read: z.unknown() }).optional(),
});

/**
 * Spec 1.2 §3.5: `provider`'s model `id` in models.dev's api.json (a provider id such as `openai` or
 * `opencode-go`, and the model id within it); null when absent or unreadable.
 */
export function modelsDevFacts(raw: unknown, provider: string, id: string): ModelFacts | null {
  const p = (raw as Record<string, { models?: Record<string, unknown> }> | null)?.[provider];
  const parsed = ModelSchema.safeParse(p?.models?.[id]);
  if (!parsed.success) return null;
  const m = parsed.data;
  const efforts = m.reasoning_options?.find((o) => o.type === "effort")?.values ?? null;
  const input = num(m.cost?.input);
  const output = num(m.cost?.output);
  return {
    efforts,
    context: num(m.limit?.context),
    output: num(m.limit?.output),
    price:
      input !== null && output !== null ? { input, cached: num(m.cost?.cache_read) ?? input, output } : null,
    toolUse: m.tool_call ?? null,
    imageIn: m.modalities?.input ? m.modalities.input.includes("image") : null,
    reasoning: m.reasoning ?? null,
    releaseDate: m.release_date ?? null,
  };
}
