import { describe, expect, it } from "bun:test";
import { postNotify } from "../../src/infra/ntfy.ts";

const m = { title: "catherd · wallet", message: "M1 landed.", tags: ["white_check_mark", "x"] };

describe("postNotify", () => {
  it("posts the message with Title and Tags, and is true on a 2xx", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await postNotify("https://ntfy.sh/t", m, { fetch: fake })).toBe(true);
    const s = seen as unknown as { url: string; init: RequestInit };
    expect(s.url).toBe("https://ntfy.sh/t");
    expect(s.init.method).toBe("POST");
    expect(s.init.body).toBe("M1 landed.");
    const h = s.init.headers as Record<string, string>;
    // a non-ASCII title travels as an RFC 2047 word, which ntfy decodes
    expect(h.Title).toBe(`=?UTF-8?B?${Buffer.from("catherd · wallet").toString("base64")}?=`);
    expect(h.Tags).toBe("white_check_mark,x");
  });

  it("sends a plain ASCII title as it is", async () => {
    let title = "";
    const fake = (async (_u: string, init: RequestInit) => {
      title = (init.headers as Record<string, string>).Title as string;
      return new Response("ok");
    }) as unknown as typeof fetch;
    await postNotify("https://ntfy.sh/t", { ...m, title: "catherd" }, { fetch: fake });
    expect(title).toBe("catherd");
  });

  it("is false on a refusal, on a server that never answers, and on a throw", async () => {
    const refuse = (async () => new Response("no", { status: 429 })) as unknown as typeof fetch;
    expect(await postNotify("https://ntfy.sh/t", m, { fetch: refuse })).toBe(false);
    // a fetch that ignores its signal still gives up after the timeout
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    expect(await postNotify("https://ntfy.sh/t", m, { fetch: hang, timeoutMs: 5 })).toBe(false);
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await postNotify("https://ntfy.sh/t", m, { fetch: boom })).toBe(false);
  });
});
