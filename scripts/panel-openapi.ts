// Writes web/openapi.json from the panel's operation table: bun run panel:openapi
import { writeFileSync } from "node:fs";
import { panelOpenApi } from "../src/entry/panel/openapi.ts";

writeFileSync(
  new URL("../web/openapi.json", import.meta.url),
  `${JSON.stringify(panelOpenApi(), null, 2)}\n`,
);
