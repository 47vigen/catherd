/**
 * Spec §3.5: the message catherd pushes to the main thread when roles finish or need attention. Pure text; the
 * notifier (services/notifier.ts) gathers the facts and infra/peer-inbox.ts sends the result.
 */

/** Spec §3.6: `later` waits for the receiver's turn to end, `next` drains at its next tool round. Never `now`. */
export type NoticePriority = "later" | "next";

/** One role's news: it finished (`record`), or an event while it runs (`stall`). */
export interface Notice {
  kind: "finished" | "stalled";
  runId: string;
  runTitle: string;
  dispatchId: string;
  name: string;
  role: string;
  /** the lane it worked, when it had one: the multi-role preview names it */
  lane: string | null;
  rung: string;
  /** the record's status, or for a limit what failover did ("limit on X; failed over to Y"), or the event */
  status: string;
  /** the reply's STATUS word, null without a STATUS line */
  replyStatus: string | null;
  secs: number;
  changedOwned: number;
  /** the worker's reply (finished notices), capped when the message is written */
  reply: string;
  priority: NoticePriority;
}

/** The body of a reply a message carries at most (spec §3.5). */
export const REPLY_CAP = 2_000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The first line of one role's block: it must stand alone, since the Desktop preview shows only it. */
export function noticeHeader(n: Notice): string {
  const head = `catherd · ${n.runTitle} · ${n.name} ${n.role} · ${n.rung} · ${n.status}`;
  if (n.kind === "stalled") return `${head} · running ${n.secs}s`;
  return [
    head,
    n.replyStatus ? `STATUS: ${n.replyStatus}` : "no STATUS",
    `${n.secs}s`,
    plural(n.changedOwned, "owned file changed", "owned files changed"),
  ].join(" · ");
}

/** The reply, at most `cap` characters, cut on a line boundary, saying where the rest is. */
export function capNoticeReply(reply: string, cap = REPLY_CAP): string {
  const text = reply.trimEnd();
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const at = cut.lastIndexOf("\n");
  return `${at > 0 ? cut.slice(0, at) : cut}\n…(cut; result(run, name) has the rest)`;
}

/**
 * The envelope's own tags are neutralised in a body, in any case (a parser may not care), so a reply can never
 * close the envelope early.
 */
const neutral = (s: string) => s.replace(/(cross)-(session)-(message)/gi, "$1 $2 $3");

function block(n: Notice): string {
  const call = `run: "${n.runId}", name: "${n.name}"`;
  if (n.kind === "stalled") return `${noticeHeader(n)}\nPeek: peek(${call})`;
  const reply = capNoticeReply(n.reply);
  return [noticeHeader(n), ...(reply ? [reply] : []), `Record: result(${call})`].join("\n");
}

/** The preview line of a message that carries several roles: `catherd · <title> · 3 roles finished: …`. */
function previewOf(ns: Notice[]): string {
  const titles = [...new Set(ns.map((n) => n.runTitle))];
  const where = titles.length === 1 ? titles[0] : plural(titles.length, "run", "runs");
  const what = ns.every((n) => n.kind === "finished")
    ? `${ns.length} roles finished`
    : `${plural(ns.length, "role", "roles")} to look at`;
  const each = ns.map(
    (n) => `${n.lane ?? n.name} ${n.kind === "stalled" ? "stalled" : n.status.split(";")[0]}`,
  );
  return `catherd · ${where} · ${what}: ${each.join(", ")}`;
}

/** The message body for one or more notices: one block per role, a preview line first when there are several. */
export function formatNotices(ns: Notice[]): string {
  if (ns.length === 1) return neutral(block(ns[0] as Notice));
  return neutral([previewOf(ns), ...ns.map(block)].join("\n\n"));
}

/** The message's priority: the most urgent of its notices. */
export const priorityOf = (ns: Notice[]): NoticePriority =>
  ns.some((n) => n.priority === "next") ? "next" : "later";

/** The envelope catherd sends: from-name only, no `from` (the MCP server has no reply address). */
export const envelope = (body: string): string =>
  `<cross-session-message from-name="catherd">\n${body}\n</cross-session-message>`;
