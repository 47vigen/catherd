import { Button, buttonVariants, FieldError, Label, Link, TextArea, TextField, toast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import type { ParkedView } from "../../client";
import { answerUnitMutation } from "../../client/@tanstack/react-query.gen";
import { errorMessage } from "../../lib/api";
import { QUICK_ANSWERS } from "../../lib/park-reasons";
import { invalidateOps } from "../../lib/query";

/** The ways to answer a parked unit: one-click answers where the reason has a known fix, and always the text box. */
export function QuestionAnswer({ q, onAnswered }: { q: ParkedView; onAnswered?: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const send = useMutation({
    ...answerUnitMutation(),
    onSuccess: async () => {
      toast.success(q.unit === "run" ? "Answer sent. The run goes on." : `Answer sent. ${q.unit} runs again.`);
      setText("");
      await invalidateOps(qc, "listQuestions", "listAnswered", "getRun", "getRunModel", "listRuns", "getOverview");
      onAnswered?.();
    },
    onError: () => void invalidateOps(qc, "listQuestions"),
  });
  const submit = (answer: string) => send.mutate({ path: { id: q.run }, body: { unit: q.unit, answer } });
  const words = text.trim();

  return (
    <div className="flex flex-col gap-3">
      {QUICK_ANSWERS[q.reason] ? (
        <div className="flex flex-wrap gap-2">
          {QUICK_ANSWERS[q.reason]!.map((a, i) =>
            a.href ? (
              <Link key={a.label} href={a.href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
                {a.label}
              </Link>
            ) : (
              <Button
                key={a.label}
                size="sm"
                variant={i === 0 ? "primary" : "secondary"}
                isDisabled={send.isPending}
                onPress={() => {
                  if (a.answer !== null) submit(a.answer);
                  else if (words === "") box.current?.focus();
                  else submit(words);
                }}
              >
                {a.label}
              </Button>
            ),
          )}
        </div>
      ) : null}
      <TextField
        value={text}
        onChange={(v) => {
          setText(v);
          if (send.error) send.reset();
        }}
        isInvalid={send.isError}
      >
        <Label>Your answer</Label>
        <TextArea ref={box} rows={3} />
        <FieldError>{send.error ? errorMessage(send.error) : undefined}</FieldError>
      </TextField>
      <div>
        <Button
          size="sm"
          variant={QUICK_ANSWERS[q.reason] ? "secondary" : "primary"}
          isDisabled={words === ""}
          isPending={send.isPending}
          onPress={() => submit(words)}
        >
          Send answer
        </Button>
      </div>
    </div>
  );
}
