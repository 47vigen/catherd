import { z } from "zod";
import { CatherdError } from "./errors.ts";

/** One model at one effort, as the Slopalytics proxy indexes it: its intelligence and the facts that come with it. */
export interface SlopRecord {
  family: string;
  effort: string;
  intelligence: number;
  inputPrice: number | null;
  outputPrice: number | null;
  speed: number | null;
  context: number | null;
  /** measured USD per task; absent in an index fetched before the field existed */
  cost?: number | null;
  /** Slopalytics lab id */
  lab?: string | null;
}

const RecordSchema = z.object({
  family: z.string(),
  effort: z.string(),
  intelligence: z.number(),
  inputPrice: z.number().nullable(),
  outputPrice: z.number().nullable(),
  speed: z.number().nullable(),
  context: z.number().nullable(),
  cost: z.number().nullable().optional(),
  lab: z.string().nullable().optional(),
});

/** `<data>/slopalytics.json`: the last good answer, when it was fetched and checked, and the last failure. */
export const IndexFileSchema = z.looseObject({
  schema: z.literal(1),
  checkedAt: z.iso.datetime(),
  fetchedAt: z.string().nullable(),
  error: z.object({ at: z.string(), message: z.string() }).nullable(),
  models: z.array(RecordSchema),
});
export type IndexFile = z.infer<typeof IndexFileSchema>;

/** A finite number or a finite numeric string (the proxy sends some prices as strings), else null. */
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

/** The proxy's answer as the records catherd ranks on: only a record with a positive intelligence is a pair. */
export function parseProxy(body: unknown): { fetchedAt: string | null; models: SlopRecord[] } {
  const b = body as { fetchedAt?: unknown; models?: unknown } | null;
  if (typeof b !== "object" || b === null || !Array.isArray(b.models))
    throw new CatherdError("E_INPUT_INVALID", "Slopalytics answered without a models list");
  const models: SlopRecord[] = [];
  for (const raw of b.models) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const intelligence = num(r.intelligence);
    if (typeof r.family !== "string" || !r.family) continue;
    if (typeof r.effort !== "string" || !r.effort) continue;
    if (intelligence === null || intelligence <= 0) continue;
    const context = num(r.context);
    const cost = num(r.cost);
    models.push({
      family: r.family,
      effort: r.effort,
      intelligence,
      inputPrice: num(r.inputPrice),
      outputPrice: num(r.outputPrice),
      speed: num(r.speed),
      context: context !== null && Number.isInteger(context) && context > 0 ? context : null,
      cost: cost !== null && cost > 0 ? cost : null,
      lab: typeof r.lab === "string" && r.lab ? r.lab : null,
    });
  }
  return { fetchedAt: typeof b.fetchedAt === "string" ? b.fetchedAt : null, models };
}

/** A model's Slopalytics family key: its provider dropped, lower case, dots as dashes (`gpt-6.1-sol` → `gpt-6-1-sol`). */
export const slopKey = (model: string): string =>
  model
    .slice(model.lastIndexOf("/") + 1)
    .toLowerCase()
    .replaceAll(".", "-");
