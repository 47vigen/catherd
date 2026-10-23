import { Chip } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { getCheckLogsOptions } from "../../../../../client/@tanstack/react-query.gen";
import { CodeBlock } from "../../../../../components/code-block/CodeBlock";
import { Term } from "../../../../../components/term/Term";
import { Empty, Loading, QueryError } from "./parts";

const TAIL = 200;

function Log({ title, text, none }: { title: ReactNode; text: string | null; none: string }) {
  const lines = text?.split("\n") ?? [];
  const cut = lines.length > TAIL;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="label-caps text-muted">{title}</h3>
      {text === null || text.trim() === "" ? (
        <Empty>{none}</Empty>
      ) : (
        <>
          {cut ? <p className="text-muted text-xs">The last {TAIL} lines of the log.</p> : null}
          <CodeBlock code={(cut ? lines.slice(-TAIL) : lines).join("\n")} lang="text" className="max-h-80" />
        </>
      )}
    </section>
  );
}

/** The logs of a lane's checks and the exit code of the last run. */
export function ChecksTab({ runId, lane }: { runId: string; lane: string | null }) {
  const logs = useQuery({ ...getCheckLogsOptions({ path: { id: runId, lane: lane ?? "" } }), enabled: lane !== null });
  if (lane === null) return <Empty>No check log yet.</Empty>;
  if (logs.isPending) return <Loading />;
  if (logs.isError) return <QueryError error={logs.error} title="Could not load the check logs" />;
  const d = logs.data;
  return (
    <div className="flex flex-col gap-4">
      {d.exit !== null ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">{d.name} exited with</span>
          <Chip size="sm" variant="soft" color={d.exit === 0 ? "success" : "danger"}>
            <Chip.Label className="font-mono text-[11px]">{d.exit}</Chip.Label>
          </Chip>
        </div>
      ) : null}
      <Log title={<Term name="fast check">Fast check</Term>} text={d.fast} none="No fast check log yet." />
      <Log title="Full check" text={d.full} none="No full check log yet." />
    </div>
  );
}
