import { Button, Link } from "@heroui/react";
import { useState } from "react";

import type { ParkedView } from "../../../client";
import { QuestionAnswer } from "../../../components/question-answer/QuestionAnswer";
import { REASON_TEXT } from "../../../lib/park-reasons";
import { formatRelative } from "../../../lib/time";

function Waiting({ q, now, startOpen }: { q: ParkedView; now: Date; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const panel = `answer-${q.run}-${q.unit}`;
  return (
    <li className="border-border bg-surface flex flex-col gap-3 rounded-sm border p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
        <Link href={`/runs/${encodeURIComponent(q.run)}`} className="min-w-0 truncate font-medium">
          {q.runTitle}
        </Link>
        <span className="text-muted font-mono text-xs">{q.unit}</span>
        <span className="text-muted ml-auto text-xs">{formatRelative(q.at, now)}</span>
      </div>
      <p className="text-muted text-xs leading-4">{REASON_TEXT[q.reason]}</p>
      <p className={`text-[13px] leading-5 whitespace-pre-wrap ${open ? "" : "line-clamp-2"}`}>{q.question}</p>
      <div className="flex flex-col gap-3" id={panel}>
        {open ? <QuestionAnswer q={q} /> : null}
      </div>
      <div>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={panel}
          onPress={() => setOpen((o) => !o)}
          className="-ml-2"
        >
          {open ? "Hide answer" : "Answer"}
        </Button>
      </div>
    </li>
  );
}

/** The first questions across runs, answerable here; the first one starts open. */
export function WaitingList({ questions, now }: { questions: { total: number; first: ParkedView[] }; now: Date }) {
  if (questions.total === 0)
    return (
      <p className="text-muted border-border rounded-sm border border-dashed px-4 py-6 text-sm">
        Nothing is waiting for you.
      </p>
    );
  return (
    <ul className="flex flex-col gap-3">
      {questions.first.map((q, i) => (
        <Waiting key={`${q.run}/${q.unit}`} q={q} now={now} startOpen={i === 0} />
      ))}
      {questions.total > questions.first.length ? (
        <li className="text-muted text-xs">and {questions.total - questions.first.length} more waiting.</li>
      ) : null}
    </ul>
  );
}
