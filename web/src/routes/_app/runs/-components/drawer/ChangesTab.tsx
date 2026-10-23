import { Button, cn } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { commitsFor } from "../../-lib/changes";
import type { Attempt, RunModel, RunNode } from "../../../../../client";
import { getCommitDiffOptions } from "../../../../../client/@tanstack/react-query.gen";
import { Empty, Loading, QueryError } from "./parts";

const STEP = 400;

const lineClass = (l: string) =>
  l.startsWith("+") && !l.startsWith("+++")
    ? "bg-success/12 text-foreground"
    : l.startsWith("-") && !l.startsWith("---")
      ? "bg-danger/12 text-foreground"
      : l.startsWith("@@")
        ? "text-ink-strong"
        : l.startsWith("diff ") || l.startsWith("index ")
          ? "text-muted"
          : "";

/** A unified diff with added and removed lines tinted; long ones show a few hundred lines at a time. */
function DiffText({ text }: { text: string }) {
  const [shown, setShown] = useState(STEP);
  const lines = text.split("\n");
  return (
    <div className="flex flex-col gap-2">
      <pre
        dir="ltr"
        className="bg-surface-secondary border-border max-h-[60vh] overflow-auto rounded-sm border py-2 font-mono text-xs leading-5"
      >
        <code className="block min-w-max">
          {lines.slice(0, shown).map((l, i) => (
            <span key={i} className={cn("block px-3 whitespace-pre", lineClass(l))}>
              {l || " "}
            </span>
          ))}
        </code>
      </pre>
      {shown < lines.length ? (
        <div>
          <Button size="sm" variant="secondary" onPress={() => setShown((n) => n + STEP)}>
            Show {Math.min(STEP, lines.length - shown)} more lines
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function CommitDiff({ runId, sha, label, lane }: { runId: string; sha: string; label: string; lane: string | null }) {
  const diff = useQuery(getCommitDiffOptions({ path: { id: runId, sha }, query: lane ? { lane } : undefined }));
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-baseline gap-2">
        <span className="font-mono text-sm">{sha.slice(0, 7)}</span>
        <span className="text-muted text-xs">{label}</span>
      </h3>
      {diff.isPending ? (
        <Loading />
      ) : diff.isError ? (
        <QueryError error={diff.error} title="Could not load this diff" />
      ) : diff.data.text.trim() === "" ? (
        <Empty>{lane ? `This commit did not change the files of ${lane}.` : "This commit changed nothing."}</Empty>
      ) : (
        <>
          {diff.data.truncated ? (
            <p className="text-warning text-xs">The diff is over 1 MB, so only its first 1 MB is shown.</p>
          ) : null}
          <DiffText text={diff.data.text} />
        </>
      )}
    </section>
  );
}

/** The diff of the commits a step produced, one block per round. */
export function ChangesTab({
  runId,
  model,
  node,
  attempt,
}: {
  runId: string;
  model: RunModel;
  node: RunNode;
  attempt: Attempt | undefined;
}) {
  const commits = commitsFor(model, node, attempt);
  const lane = node.kind === "lane" ? node.lane : null;
  if (commits.length === 0) return <Empty>No commit yet.</Empty>;
  return (
    <div className="flex flex-col gap-5">
      {lane ? <p className="text-muted text-xs">The commit is per milestone; this shows this lane's files.</p> : null}
      {commits.map((c) => (
        <CommitDiff key={c.sha} runId={runId} sha={c.sha} label={c.label} lane={lane} />
      ))}
    </div>
  );
}
