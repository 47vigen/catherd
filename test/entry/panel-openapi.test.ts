import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPERATIONS, panelOpenApi } from "../../src/entry/panel/openapi.ts";

describe("the panel's OpenAPI document", () => {
  it("web/openapi.json is what bun run panel:openapi writes", () =>
    expect(readFileSync(join(import.meta.dir, "../../web/openapi.json"), "utf8")).toBe(
      `${JSON.stringify(panelOpenApi(), null, 2)}\n`,
    ));

  it("names every operation once, with no socket and no package version", () => {
    const doc = panelOpenApi() as {
      info: { version: string };
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    expect(
      Object.values(doc.paths)
        .flatMap((p) => Object.values(p).map((o) => o.operationId))
        .sort(),
    ).toEqual(OPERATIONS.map((o) => o.id).sort());
    expect([Object.keys(doc.paths).some((p) => p.endsWith("/live")), doc.info.version]).toEqual([false, "1"]);
  });
});
