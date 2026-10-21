import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog, type Catalog, ModelsFileSchema } from "../../src/domain/catalog.ts";
import { type IndexFile, IndexFileSchema, type SlopRecord } from "../../src/domain/slopalytics.ts";

const read = (...parts: string[]): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "..", ...parts), "utf8"));

export const shippedModels = () => ModelsFileSchema.parse(read("catalog", "models.json"));
/** The recorded Slopalytics index (test/fixtures/slopalytics.json). */
export const fixtureIndex = (): IndexFile =>
  IndexFileSchema.parse(read("test", "fixtures", "slopalytics.json"));

/** The shipped catalog on the recorded index (or `index`), with optional listings. */
export function shipped(o: { listed?: Catalog["listed"]; index?: IndexFile | null } = {}): Catalog {
  return buildCatalog({
    models: shippedModels(),
    index: o.index === undefined ? fixtureIndex() : o.index,
    ...(o.listed ? { listed: o.listed } : {}),
  });
}

/** An index of only these pairs: `"<Slopalytics family>#<effort>"` → intelligence, or a partial record. */
export function indexOf(
  pairs: Record<string, number | Partial<SlopRecord>>,
  fetchedAt = "2026-10-13T20:47:14.735Z",
): IndexFile {
  return {
    schema: 1,
    checkedAt: fetchedAt,
    fetchedAt,
    error: null,
    models: Object.entries(pairs).map(([k, v]) => {
      const [family, effort] = k.split("#") as [string, string];
      const rec = typeof v === "number" ? { intelligence: v } : v;
      return {
        family,
        effort,
        intelligence: 1,
        inputPrice: null,
        outputPrice: null,
        speed: null,
        context: null,
        ...rec,
      };
    }),
  };
}
