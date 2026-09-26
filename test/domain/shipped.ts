import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCatalog,
  type Catalog,
  ModelsFileSchema,
  type Override,
  ScoresFileSchema,
} from "../../src/domain/catalog.ts";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "catalog", name), "utf8"));

export const shippedModels = () => ModelsFileSchema.parse(read("models.json"));
export const shippedScores = () => ScoresFileSchema.parse(read("scores.json"));

/** The shipped catalog, with optional listings, override and timings layered on. */
export function shipped(
  o: { listed?: Catalog["listed"]; override?: Override; secs?: Catalog["secs"] } = {},
): Catalog {
  return buildCatalog({ models: shippedModels(), scores: shippedScores(), ...o });
}
