import { Button, buttonVariants, FieldError, Kbd, Label, Link, TextArea, TextField, toast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";

import type { ParkedView } from "../../client";
import { answerUnitMutation } from "../../client/@tanstack/react-query.gen";
import { errorMessage } from "../../lib/api";
import { QUICK_ANSWERS } from "../../lib/park-reasons";
import { invalidateOps } from "../../lib/query";

/**
 * The ways to answer a parked unit: one-click answers where the reason has a known fix, and always the text box,
 * which sends on Cmd/Ctrl+Enter. `aside` sits left of Send, for links about the question.
 */
export function QuestionAnswer({
  q,
  onAnswered,
  aside,
}: {
  q: ParkedView;
  onAnswered?: () => void;
  aside?: ReactNode;
}) {
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
  const quick = QUICK_ANSWERS[q.reason];

  return (
    <div className="flex flex-col gap-3">
      {quick ? (
        <div className="flex flex-wrap gap-2">
          {quick.map((a, i) =>
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
        <Label className="sr-only">Your answer</Label>
        <TextArea
          ref={box}
          rows={2}
          placeholder={quick ? "Or write an answer…" : "Write your answer…"}
          className="min-h-16 resize-y text-[13px]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && words !== "" && !send.isPending) {
              e.preventDefault();
              submit(words);
            }
          }}
        />
        <FieldError>{send.error ? errorMessage(send.error) : undefined}</FieldError>
      </TextField>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="text-muted flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">{aside}</div>
        <div className="ml-auto flex items-center gap-2">
          <Kbd aria-hidden="true" variant="light" className="hidden sm:inline-flex">
            <Kbd.Abbr keyValue="command" />
            <Kbd.Abbr keyValue="enter" />
          </Kbd>
          <Button
            size="sm"
            variant={quick ? "secondary" : "primary"}
            isDisabled={words === ""}
            isPending={send.isPending}
            onPress={() => submit(words)}
          >
            Send answer
          </Button>
        </div>
      </div>
    </div>
  );
}
