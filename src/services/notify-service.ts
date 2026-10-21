import { notifyMessage } from "../domain/notify.ts";
import type { NotifyMoment } from "../domain/profile.ts";
import { postNotify } from "../infra/ntfy.ts";
import type { Deps } from "./ports.ts";
import { runProfile } from "./run-pin.ts";
import type { Run } from "./run-store.ts";

/**
 * Tells the owner's phone about a moment of a run, when the run's profile lists that moment. False when it is
 * not listed, or the message did not go out; it never throws.
 */
export async function sendRunNotice(
  deps: Deps,
  run: Run,
  i: { unit: string; moment: NotifyMoment },
  o: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  if (!runProfile(deps, run).notify.includes(i.moment)) return false;
  // CATHERD_NO_END_PUSH=1 (the test preload sets it) keeps every real send off; a test's own fetch still goes
  if (process.env.CATHERD_NO_END_PUSH === "1" && !o.fetch) return false;
  return postNotify(
    deps.profiles.notifyUrl(),
    notifyMessage({ runId: run.id, runTitle: run.meta.title, unit: i.unit, moment: i.moment }),
    o,
  );
}
