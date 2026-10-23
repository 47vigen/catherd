import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../infra/paths.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { replayRun } from "./run-events-store.ts";
import { notifyMessage } from "../domain/notify.ts";
import type { NotifyMoment } from "../domain/profile.ts";
import { postNotify } from "../infra/ntfy.ts";
import type { Deps } from "./ports.ts";
import { runProfile } from "./run-pin.ts";
import type { Run } from "./run-store.ts";

const panelOriginFile = (): string => join(dataDir(), "panel-origin");

/** Shared with the daemon and role processes that send notices. */
export function recordPanelOrigin(_deps: Deps, origin: string | null): void {
  if (origin === null) rmSync(panelOriginFile(), { force: true });
  else writeTextAtomic(panelOriginFile(), new URL(origin).origin);
}

export function panelOrigin(_deps: Deps): string | null {
  try {
    return new URL(readFileSync(panelOriginFile(), "utf8")).origin;
  } catch {
    return null;
  }
}

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
  const state = replayRun(run);
  const question = state.questions[i.unit];
  return postNotify(
    deps.profiles.notifyUrl(),
    notifyMessage({
      runId: run.id,
      runTitle: run.meta.title,
      unit: i.unit,
      moment: i.moment,
      reason: question?.reason,
      question: question?.question,
      outcome: state.outcome ?? undefined,
      panelUrl: panelOrigin(deps),
    }),
    o,
  );
}
