import { TranscriptView } from "../transcript/TranscriptView";
import { Empty } from "./parts";

/** The role's stream as a readable transcript, with its raw JSON lines one switch away. */
export function LogTab({ runId, dispatchId, live }: { runId: string; dispatchId: string | null; live: boolean }) {
  if (dispatchId === null) return <Empty>No log yet.</Empty>;
  return <TranscriptView runId={runId} dispatchId={dispatchId} live={live} />;
}
