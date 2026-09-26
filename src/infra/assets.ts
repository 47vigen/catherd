import { fileURLToPath } from "node:url";

/** A file shipped in the package, such as `catalog/models.json`; catherd ships its sources unbuilt. */
export const assetPath = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
