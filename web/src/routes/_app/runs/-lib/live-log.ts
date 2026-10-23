import { createContext } from "react";

import type { TranscriptFrame } from "../-hooks/useLiveRun";

/** The run socket's stream tail, as the run page hands it to the log: null when the page has no live socket. */
export type LiveLog = {
  watch(dispatchId: string | null, from: number): void;
  /** Calls `fn` with each transcript frame; returns the unsubscribe. */
  subscribe(fn: (f: TranscriptFrame) => void): () => void;
};

export const LiveLogContext = createContext<LiveLog | null>(null);
