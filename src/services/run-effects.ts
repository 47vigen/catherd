import type { Action } from "../domain/run-machine.ts";
import type { RunState } from "../domain/run-state.ts";

/**
 * What carries the machine's actions out. `run` appends the events the action produces (a long one when it is
 * done), never throws: a failure becomes an `effect.failed` event.
 */
export interface Effects {
  run(a: Action, state: RunState): Promise<void>;
}
