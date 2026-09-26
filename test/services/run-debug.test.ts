import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tail } from "../../src/services/run-debug.ts";

describe("tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "catherd-tail-"));
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} é🐈`);
  const file = join(dir, "stderr");
  writeFileSync(file, `${lines.join("\n")}\n\n  \n`);

  it("reads the last lines from the end, keeping a line and a character split between reads whole", () => {
    // 7-byte reads split lines and multi-byte characters over and over
    expect(tail(file, 20, 7)).toEqual(lines.slice(-20));
    expect(tail(file, 20)).toEqual(lines.slice(-20));
  });

  it("returns every line of a file shorter than asked, and nothing for a missing file", () => {
    expect(tail(file, 5000, 64)).toEqual(lines);
    expect(tail(join(dir, "missing"))).toEqual([]);
  });
});
