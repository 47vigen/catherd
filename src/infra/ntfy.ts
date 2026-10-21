import type { NotifyMessage } from "../domain/notify.ts";
import { log } from "./log.ts";

/** A header value as ntfy reads it: plain ASCII as it is, anything else as an RFC 2047 encoded word. */
const headerValue = (s: string): string =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`;

/**
 * Posts one message to an ntfy topic. True once the server accepted it; any error, a non-2xx answer or a
 * server slower than `timeoutMs` is false, never a throw, and the log never carries the topic (the url is a
 * secret of the user's).
 */
export async function postNotify(
  url: string,
  m: NotifyMessage,
  o: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sent = (o.fetch ?? fetch)(url, {
      method: "POST",
      body: m.message,
      headers: { Title: headerValue(m.title), Tags: m.tags.join(",") },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // a fetch that ignores its signal still gives up
    const gaveUp = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
    });
    const res = await Promise.race([sent, gaveUp]);
    if (!res.ok) log("warn", "notify", { ntfy: res.status });
    return res.ok;
  } catch (e) {
    log("warn", "notify", { ntfy: e instanceof Error ? e.name : "error" });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
