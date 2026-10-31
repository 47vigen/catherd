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
    <div className="flex flex-col">
      <pre dir="ltr" className="bg-surface-secondary max-h-[60vh] overflow-auto py-2 font-mono text-xs leading-5">
        <code className="block min-w-max">
          {lines.slice(0, shown).map((l, i) => (
            <span key={i} className={cn("block px-3 whitespace-pre", lineClass(l))}>
              {l || " "}
            </span>
          ))}
        </code>
      </pre>
      {shown < lines.length ? (
        <div className="px-3 pb-3">
          <Button size="sm" variant="secondary" onPress={() => setShown((n) => n + STEP)}>
            Show {Math.min(STEP, lines.length - shown)} more lines
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Lines added and removed, read off the diff itself (file headers are not changes). */
function counts(text: string) {
  let add = 0;
  let del = 0;
  for (const l of text.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return {
    add,
    del,
    files: text.split("\n").filter((l) => l.startsWith("diff ")).length,
  };
}

function CommitDiff({ runId, sha, label, lane }: { runId: string; sha: string; label: string; lane: string | null }) {
  const diff = useQuery(
    getCommitDiffOptions({
      path: { id: runId, sha },
      query: lane ? { lane } : undefined,
    }),
  );
  const c = diff.data && diff.data.text.trim() !== "" ? counts(diff.data.text) : null;
  return (
    <section aria-label={`Commit ${sha.slice(0, 7)}`} className="border-border overflow-hidden rounded-sm border">
      <h3 className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-3 py-2.5">
        <span className="font-mono text-[13px]">{sha.slice(0, 7)}</span>
        <span className="text-muted text-xs">{label}</span>
        {c ? (
          <span className="ms-auto flex gap-2 font-mono text-xs tabular-nums">
            {c.files > 0 ? <span className="text-muted">{c.files} files</span> : null}
            <span className="text-success">+{c.add}</span>
            <span className="text-danger">−{c.del}</span>
          </span>
        ) : null}
      </h3>
      {diff.isPending ? (
        <Loading label="Reading the diff" />
      ) : diff.isError ? (
        <div className="p-3">
          <QueryError error={diff.error} title="Could not load this diff" />
        </div>
      ) : diff.data.text.trim() === "" ? (
        <p className="text-muted px-3 py-6 text-center text-sm">
          {lane ? `This commit did not change the files of ${lane}.` : "This commit changed nothing."}
        </p>
      ) : (
        <>
          {diff.data.truncated ? (
            <p className="text-warning border-border border-b px-3 py-2 text-xs">
              The diff is over 1 MB, so only its first 1 MB is shown.
            </p>
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
    <>
      {lane ? <p className="text-muted text-xs">The commit is per milestone; this shows this lane's files.</p> : null}
      {commits.map((c) => (
        <CommitDiff key={c.sha} runId={runId} sha={c.sha} label={c.label} lane={lane} />
      ))}
    </>
  );
}
