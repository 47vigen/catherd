import { createContext } from "react";

import type { LiveFrame } from "../-hooks/useLiveRun";

/** The run socket's stream tail, as the run page hands it to the log: null when the page has no live socket. */
export type LiveLog = {
  watch(dispatchId: string | null, from: number): void;
  /** Calls `fn` with each transcript frame, or the error that ended the tail; returns the unsubscribe. */
  subscribe(fn: (f: LiveFrame) => void): () => void;
};

export const LiveLogContext = createContext<LiveLog | null>(null);
