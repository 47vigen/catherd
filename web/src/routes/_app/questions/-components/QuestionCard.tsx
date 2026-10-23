import { ChevronRight } from "@gravity-ui/icons";
import { Link } from "@heroui/react";
import { useState } from "react";

import type { QuestionView } from "../../../../client";
import { CodeBlock } from "../../../../components/code-block/CodeBlock";
import { Markdown } from "../../../../components/markdown/Markdown";
import { QuestionAnswer } from "../../../../components/question-answer/QuestionAnswer";
import { StatusChip } from "../../../../components/status-chip/StatusChip";
import { REASON_TEXT } from "../../../../lib/park-reasons";
import { formatRelative } from "../../../../lib/time";

const graph = (q: QuestionView, tab: string) =>
  `/runs/${encodeURIComponent(q.run)}?node=${encodeURIComponent(q.context.node)}&tab=${tab}`;

/** One parked unit: where it sits, why it stopped, what the role last said, and every way to answer it. */
export function QuestionCard({ q, now }: { q: QuestionView; now: Date }) {
  const [replyOpen, setReplyOpen] = useState(false);
  const { reply, replyName, lane } = q.context;

  return (
    <article className="border-border bg-surface flex flex-col gap-4 rounded-sm border p-4">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
          <Link href={`/runs/${encodeURIComponent(q.run)}`} className="text-[15px] font-medium">
            {q.runTitle}
          </Link>
          <span className="bg-surface-tertiary rounded-sm px-1.5 py-0.5 font-mono text-xs">
            {q.unit === "run" ? "Run" : q.unit}
          </span>
          <StatusChip status="parked" label={q.reason.replaceAll("_", " ")} />
          <span className="text-muted ml-auto">{formatRelative(q.at, now)}</span>
        </div>
        <p className="text-muted text-[13px] leading-5">{REASON_TEXT[q.reason]}</p>
      </header>

      <CodeBlock code={q.question} lang="text" />

      {reply ? (
        <details className="group border-border rounded-sm border" onToggle={(e) => setReplyOpen(e.currentTarget.open)}>
          <summary className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1.5 px-3 py-2 text-[13px] select-none">
            <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90" />
            {replyName ?? "The role"}&apos;s latest reply
          </summary>
          <div className="border-border max-h-96 overflow-auto border-t px-3 py-2 text-sm">
            {replyOpen ? <Markdown source={reply} /> : null}
          </div>
        </details>
      ) : null}

      <nav aria-label="Where to look" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        <Link href={graph(q, "overview")}>Open in the graph</Link>
        {lane ? <Link href={graph(q, "prompt")}>Lane</Link> : null}
        <Link href={`/runs/${encodeURIComponent(q.run)}#plan`}>Plan</Link>
      </nav>

      <div className="border-border border-t pt-4">
        <QuestionAnswer q={q} />
      </div>
    </article>
  );
}
