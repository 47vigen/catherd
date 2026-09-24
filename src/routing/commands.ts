import { defineCommand } from "citty";
import { loadCatalog, refreshModelsDev, snapshotPath } from "./catalog.ts";

const refresh = defineCommand({
  meta: { name: "refresh", description: "Refresh the local models.dev snapshot" },
  async run() {
    try {
      const { models } = await refreshModelsDev();
      console.log(
        `catherd: ${models} models from models.dev → ${snapshotPath()} (catalog: ${loadCatalog().models.length} models)`,
      );
    } catch (e) {
      console.error(`catherd: catalog refresh failed: ${(e as Error).message}`);
      process.exitCode = 1;
    }
  },
});

export const catalogCommand = defineCommand({
  meta: { name: "catalog", description: "The model catalog" },
  subCommands: { refresh },
});
