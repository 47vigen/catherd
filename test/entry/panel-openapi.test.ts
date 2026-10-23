import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AttemptSchema } from "../../src/domain/run-graph.ts";
import { DispatchDetailSchema } from "../../src/services/run-files.ts";
import { OPERATIONS, panelOpenApi } from "../../src/entry/panel/openapi.ts";

describe("the panel's OpenAPI document", () => {
  it("web/openapi.json is what bun run panel:openapi writes", () =>
    expect(readFileSync(join(import.meta.dir, "../../web/openapi.json"), "utf8")).toBe(
      `${JSON.stringify(panelOpenApi(), null, 2)}\n`,
    ));

  it("preserves optional cache-write tokens in dispatch and graph responses", () => {
    const old = { input: 100, cached: 20, output: 10 };
    const current = { ...old, cacheWrite: 30 };
    for (const schema of [
      AttemptSchema.shape.tokens.unwrap(),
      DispatchDetailSchema.shape.record.unwrap().shape.tokens,
    ]) {
      expect(schema.parse(old)).toEqual(old);
      expect(schema.parse(current)).toEqual(current);
    }
  });

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
