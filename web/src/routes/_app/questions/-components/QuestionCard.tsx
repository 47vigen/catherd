import { ChevronRight } from "@gravity-ui/icons";
import { Link } from "@heroui/react";
import { useState } from "react";

import type { QuestionView } from "../../../../client";
import { Markdown } from "../../../../components/markdown/Markdown";
import { QuestionAnswer } from "../../../../components/question-answer/QuestionAnswer";
import { StatusChip } from "../../../../components/status-chip/StatusChip";
import { Tile } from "../../../../components/tile/Tile";
import { REASON_TEXT } from "../../../../lib/park-reasons";
import { formatRelative } from "../../../../lib/time";

const graph = (q: QuestionView, tab: string) =>
  `/runs/${encodeURIComponent(q.run)}?node=${encodeURIComponent(q.context.node)}&tab=${tab}`;

/** One parked unit: where it sits, why it stopped, what the role last said, and every way to answer it. */
export function QuestionCard({ q, now }: { q: QuestionView; now: Date }) {
  const [replyOpen, setReplyOpen] = useState(false);
  const { reply, replyName, lane } = q.context;

  return (
    <Tile
      title={
        <>
          <Link
            href={`/runs/${encodeURIComponent(q.run)}`}
            className="text-foreground text-[11px] no-underline hover:underline"
          >
            {q.runTitle}
          </Link>
          {[q.unit !== "run" ? q.unit : null, replyName].filter(Boolean).map((part) => (
            <span key={part}>
              <span aria-hidden="true"> · </span>
              <span>{part}</span>
            </span>
          ))}
        </>
      }
      aside={
        <span className="flex shrink-0 items-center gap-3">
          <StatusChip status="parked" label={q.reason === "needs_user" ? "needs you" : q.reason.replaceAll("_", " ")} />
          <time dateTime={q.at} className="text-muted text-xs whitespace-nowrap tabular-nums">
            {formatRelative(q.at, now)}
          </time>
        </span>
      }
      bodyClassName="gap-4 p-4"
    >
      <div className="flex flex-col gap-1.5">
        <p className="max-h-64 overflow-auto text-[15px] leading-6 font-medium break-words whitespace-pre-wrap">
          {q.question}
        </p>
        <p className="text-muted text-[13px] leading-5">{REASON_TEXT[q.reason]}</p>
      </div>

      {reply ? (
        <details
          className="group border-border bg-surface-secondary/40 rounded-sm border"
          onToggle={(e) => setReplyOpen(e.currentTarget.open)}
        >
          <summary className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1.5 px-3 py-2 text-[13px] select-none">
            <ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-90" />
            {replyName ?? "The role"}&apos;s latest reply
          </summary>
          <div className="border-border max-h-96 overflow-auto border-t px-3 py-2 text-sm">
            {replyOpen ? <Markdown source={reply} /> : null}
          </div>
        </details>
      ) : null}

      <QuestionAnswer
        q={q}
        aside={
          <nav aria-label="Where to look" className="contents">
            <Link href={graph(q, "overview")} className="text-[13px]">
              Open in the graph
            </Link>
            {lane ? (
              <Link href={graph(q, "prompt")} className="text-[13px]">
                Lane
              </Link>
            ) : null}
            <Link href={`/runs/${encodeURIComponent(q.run)}#plan`} className="text-[13px]">
              Plan
            </Link>
          </nav>
        }
      />
    </Tile>
  );
}
