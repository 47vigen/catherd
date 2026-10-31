import { ArrowUpRightFromSquare } from "@gravity-ui/icons";
import { Link } from "@heroui/react";

import type { QuestionView } from "../../../../client";
import { Markdown } from "../../../../components/markdown/Markdown";
import { QuestionAnswer } from "../../../../components/question-answer/QuestionAnswer";
import { StatusChip } from "../../../../components/status-chip/StatusChip";
import { Tile } from "../../../../components/tile/Tile";
import { REASON_TEXT } from "../../../../lib/park-reasons";
import { formatRelative } from "../../../../lib/time";
import { reasonLabel, waited } from "./wait";

const graph = (q: QuestionView, tab: string) =>
  `/runs/${encodeURIComponent(q.run)}?node=${encodeURIComponent(q.context.node)}&tab=${tab}`;

/**
 * The question in front of you: where it sits, why it stopped, what the role last said (open, since it is what you
 * decide from), and every way to answer it.
 */
export function QuestionDetail({ q, now, className }: { q: QuestionView; now: Date; className?: string }) {
  const { reply, replyName, lane } = q.context;
  const wait = waited(q.at, now);
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
          <StatusChip status="parked" label={reasonLabel(q.reason)} />
          <time
            dateTime={q.at}
            title={new Date(q.at).toLocaleString()}
            className={`text-xs whitespace-nowrap tabular-nums ${wait.tone}`}
          >
            waiting {formatRelative(q.at, now).replace(/ ago$/, "")}
          </time>
        </span>
      }
      className={className}
      bodyClassName="gap-5 p-5"
    >
      <section aria-label="Question" className="flex flex-col gap-2">
        <p className="max-h-72 overflow-auto text-[17px] leading-7 font-medium tracking-[-0.01em] break-words whitespace-pre-wrap">
          {q.question}
        </p>
        <p className="text-muted text-[13px] leading-5">{REASON_TEXT[q.reason]}</p>
      </section>

      {reply ? (
        <section aria-label="Latest reply" className="border-border bg-surface-secondary/40 rounded-sm border">
          <h3 className="label-caps text-muted border-border flex items-center justify-between border-b px-3 py-2">
            {replyName ?? "The role"}&apos;s latest reply
            <Link href={graph(q, "output")} className="text-muted hover:text-foreground gap-1 text-[11px] no-underline">
              Full output
              <ArrowUpRightFromSquare aria-hidden="true" className="size-3" />
            </Link>
          </h3>
          <div className="max-h-80 overflow-auto px-3 py-2.5 text-sm">
            <Markdown source={reply} />
          </div>
        </section>
      ) : null}

      <div className="border-border mt-auto border-t pt-4">
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
      </div>
    </Tile>
  );
}
