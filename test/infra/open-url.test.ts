import { describe, expect, it } from "bun:test";
import { openerFor } from "../../src/infra/open-url.ts";

describe("openerFor", () => {
  it("opens with the platform's own opener", () => {
    const url = "http://127.0.0.1:4317/login#token=t";
    expect(openerFor("darwin", url)).toEqual(["open", url]);
    expect(openerFor("win32", url)).toEqual(["cmd", "/c", "start", "", url]);
    expect(openerFor("linux", url)).toEqual(["xdg-open", url]);
  });
});
