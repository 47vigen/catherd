import { describe, expect, it } from "bun:test";
import { strayPositionals } from "./contract.ts";

const shape = { subcommands: ["exec"], valueFlags: ["-m"], thread: "t-1" };

describe("strayPositionals", () => {
  it("accepts subcommands, flags, value-flag values and anything after --", () => {
    expect(strayPositionals(["exec", "--json", "-m", "gpt", "--", "thread", "-"], shape)).toEqual([]);
  });

  it("names a positional before --, including one after a boolean flag", () => {
    expect(strayPositionals(["exec", "--json", "thread", "--", "-"], shape)).toEqual(["thread"]);
    expect(strayPositionals(["brief text"], shape)).toEqual(["brief text"]);
  });
});
