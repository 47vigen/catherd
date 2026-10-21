import { Button, FieldError, Label, Link, TextArea, TextField, toast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { ParkedView } from "../../../../client";
import { answerUnitMutation } from "../../../../client/@tanstack/react-query.gen";
import { CodeBlock } from "../../../../components/code-block/CodeBlock";
import { StatusChip } from "../../../../components/status-chip/StatusChip";
import { errorMessage } from "../../../../lib/api";
import { invalidateOps } from "../../../../lib/query";
import { formatRelative } from "../../../../lib/time";

/** One parked unit: what it asked, and a box that answers it so it runs again. */
export function QuestionCard({ q, now }: { q: ParkedView; now: Date }) {
  const qc = useQueryClient();
  const [answer, setAnswer] = useState("");
  const send = useMutation({
    ...answerUnitMutation(),
    onSuccess: async () => {
      toast.success(`Answer sent. ${q.unit} runs again.`);
      setAnswer("");
      await invalidateOps(qc, "listQuestions", "getRun", "listRuns");
    },
    onError: () => void invalidateOps(qc, "listQuestions"),
  });

  return (
    <article className="border-border bg-surface flex flex-col gap-3 rounded-sm border p-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <Link href={`/runs/${encodeURIComponent(q.run)}`} className="font-medium">
          {q.runTitle}
        </Link>
        <span className="font-mono text-xs">{q.unit}</span>
        <StatusChip status="parked" />
        <span className="text-muted font-mono text-xs">{q.reason}</span>
        <span className="text-muted ml-auto">{formatRelative(q.at, now)}</span>
      </header>
      <CodeBlock code={q.question} lang="text" />
      <TextField
        value={answer}
        onChange={(v) => {
          setAnswer(v);
          if (send.error) send.reset();
        }}
        isInvalid={send.isError}
      >
        <Label>Your answer</Label>
        <TextArea rows={3} />
        <FieldError>{send.error ? errorMessage(send.error) : undefined}</FieldError>
      </TextField>
      <div>
        <Button
          size="sm"
          variant="primary"
          isDisabled={answer.trim() === ""}
          isPending={send.isPending}
          onPress={() => send.mutate({ path: { id: q.run }, body: { unit: q.unit, answer: answer.trim() } })}
        >
          Send answer
        </Button>
      </div>
    </article>
  );
}
