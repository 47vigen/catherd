import { Button, Link } from "@heroui/react";
import { useState } from "react";

import type { ParkedView } from "../../../client";
import { QuestionAnswer } from "../../../components/question-answer/QuestionAnswer";
import { Tile } from "../../../components/tile/Tile";
import { REASON_TEXT } from "../../../lib/park-reasons";
import { formatRelative } from "../../../lib/time";

function Waiting({ q, now }: { q: ParkedView; now: Date }) {
  const [open, setOpen] = useState(false);
  const panel = `answer-${q.run}-${q.unit}`;
  return (
    <li className="flex flex-col gap-2 p-4">
      <div className="flex min-w-0 items-baseline gap-2 text-xs">
        <Link href={`/runs/${encodeURIComponent(q.run)}`} className="min-w-0 truncate text-xs font-medium">
          {q.runTitle}
        </Link>
        <span className="text-muted shrink-0 font-mono">{q.unit}</span>
        <span className="text-muted ml-auto shrink-0">{formatRelative(q.at, now)}</span>
      </div>
      <p className={`text-[13px] leading-5 font-medium whitespace-pre-wrap ${open ? "" : "line-clamp-2"}`}>
        {q.question}
      </p>
      <p className="text-muted text-xs leading-4">{REASON_TEXT[q.reason]}</p>
      <div className="flex flex-col gap-3" id={panel}>
        {open ? <QuestionAnswer q={q} /> : null}
      </div>
      <div>
        <Button
          size="sm"
          variant={open ? "ghost" : "secondary"}
          aria-expanded={open}
          aria-controls={panel}
          onPress={() => setOpen((o) => !o)}
        >
          {open ? "Hide answer" : "Answer"}
        </Button>
      </div>
    </li>
  );
}

/** The first questions across runs, each answerable here behind its Answer button. */
export function WaitingList({
  questions,
  now,
  className,
}: {
  questions: { total: number; first: ParkedView[] };
  now: Date;
  className?: string;
}) {
  return (
    <Tile
      title="Waiting for you"
      className={className}
      aside={
        <span className="flex items-center gap-3 text-xs">
          {questions.total > 0 ? (
            <span className="text-warning flex items-center gap-1.5 font-mono">
              <span aria-hidden="true" className="bg-warning size-1.5 rounded-full" />
              {questions.total} waiting
            </span>
          ) : null}
          <Link href="/questions" className="text-xs">
            All questions
          </Link>
        </span>
      }
    >
      {questions.total === 0 ? (
        <p className="text-muted flex items-center gap-2.5 px-4 py-3.5 text-sm">
          <span aria-hidden="true" className="bg-success size-1.5 rounded-full" />
          Nothing is waiting for you.
        </p>
      ) : (
        <ul className="divide-border flex flex-col divide-y">
          {questions.first.map((q) => (
            <Waiting key={`${q.run}/${q.unit}`} q={q} now={now} />
          ))}
          {questions.total > questions.first.length ? (
            <li className="text-muted px-4 py-3 text-xs">
              and {questions.total - questions.first.length} more waiting.
            </li>
          ) : null}
        </ul>
      )}
    </Tile>
  );
}
