import { Alert, Chip, cn } from "@heroui/react";
import type { ReactNode } from "react";

import { CodeBlock } from "../../../../../components/code-block/CodeBlock";
import { cardText, type Card } from "./merge";

const number = new Intl.NumberFormat("en-US");

const costText = (usd: number) => `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;

/** A long output scrolls inside its card instead of stretching the log. */
function Output({ text, danger }: { text: string; danger?: boolean }) {
  return (
    <pre
      dir="auto"
      className={cn(
        "max-h-72 overflow-auto px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap",
        danger ? "text-danger" : "text-muted",
      )}
    >
      {text}
    </pre>
  );
}

function Frame({ tone, children }: { tone?: "danger"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "bg-surface-secondary overflow-hidden rounded-md border text-sm",
        tone === "danger" ? "border-danger/50" : "border-border",
      )}
    >
      {children}
    </div>
  );
}

function Head({ children, chip }: { children: ReactNode; chip?: ReactNode }) {
  return (
    <div className="border-border flex min-w-0 items-center gap-2 border-b px-3 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {chip}
    </div>
  );
}

function ExitChip({ exit }: { exit: number | null }) {
  const color = exit === null ? "default" : exit === 0 ? "success" : "danger";
  return (
    <Chip size="sm" variant="soft" color={color}>
      <Chip.Label className="font-mono text-[11px]">{exit === null ? "Running" : `Exit ${exit}`}</Chip.Label>
    </Chip>
  );
}

function CardView({ card }: { card: Card }) {
  switch (card.kind) {
    case "text":
      return (
        <p dir="auto" className="text-foreground text-sm leading-6 break-words whitespace-pre-wrap">
          {card.text}
        </p>
      );
    case "thinking":
      return (
        <details className="group text-muted text-sm">
          <summary className="hover:text-foreground cursor-pointer text-xs font-medium select-none">Thinking</summary>
          <p dir="auto" className="border-border mt-1.5 border-s-2 ps-3 leading-6 break-words whitespace-pre-wrap">
            {card.text}
          </p>
        </details>
      );
    case "tool":
      return (
        <Frame tone={card.error ? "danger" : undefined}>
          <Head
            chip={
              card.error ? (
                <Chip size="sm" variant="soft" color="danger">
                  <Chip.Label className="text-[11px]">Failed</Chip.Label>
                </Chip>
              ) : null
            }
          >
            <span className="truncate font-mono text-[13px] font-semibold">{card.name}</span>
          </Head>
          {card.input.trim() ? (
            <CodeBlock code={card.input} lang="json" className="max-h-60 rounded-none border-0" />
          ) : null}
          {card.output === null ? null : (
            <div className="border-border border-t">
              <Output text={card.output} danger={card.error} />
            </div>
          )}
        </Frame>
      );
    case "shell":
      return (
        <Frame tone={card.exit !== null && card.exit !== 0 ? "danger" : undefined}>
          <Head chip={<ExitChip exit={card.exit} />}>
            <code dir="ltr" className="min-w-0 font-mono text-xs leading-5 break-all whitespace-pre-wrap">
              <span className="text-success me-2 select-none">$</span>
              {card.command}
            </code>
          </Head>
          {card.output ? <Output text={card.output} /> : null}
        </Frame>
      );
    case "file":
      return (
        <Frame>
          <Head>
            <ul className="flex min-w-0 flex-col gap-1">
              {card.changes.map((c) => (
                <li key={`${c.kind}:${c.path}`} className="flex min-w-0 items-center gap-2">
                  <Chip size="sm" variant="soft">
                    <Chip.Label className="text-[11px]">{c.kind}</Chip.Label>
                  </Chip>
                  <span dir="ltr" className="truncate font-mono text-xs">
                    {c.path}
                  </span>
                </li>
              ))}
            </ul>
          </Head>
          {card.diff ? <CodeBlock code={card.diff} lang="diff" className="max-h-96 rounded-none border-0" /> : null}
        </Frame>
      );
    case "error":
      return (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Error</Alert.Title>
            <Alert.Description className="break-words whitespace-pre-wrap">{card.text}</Alert.Description>
          </Alert.Content>
        </Alert>
      );
    case "turn": {
      const parts = ["Turn ended"];
      if (card.tokens) parts.push(`${number.format(card.tokens.input + card.tokens.output)} tokens`);
      if (card.costUsd !== null) parts.push(costText(card.costUsd));
      return <p className="text-muted border-border border-t pt-1.5 text-xs">{parts.join(" · ")}</p>;
    }
    case "raw":
      return (
        <pre dir="ltr" className="text-muted font-mono text-xs leading-5 break-words whitespace-pre-wrap">
          {card.text}
        </pre>
      );
  }
}

/** The cards (or the raw lines) of one role's log, filtered by `query`; it draws, the container above it fetches. */
export function TranscriptCards({
  cards,
  raw,
  showRaw,
  query,
  live,
}: {
  cards: Card[];
  raw: string[] | null;
  showRaw: boolean;
  query: string;
  live: boolean;
}) {
  const needle = query.trim().toLowerCase();
  const keep = (text: string) => !needle || text.toLowerCase().includes(needle);
  const lines = (raw ?? []).filter(keep);
  const shown = cards.filter((c) => keep(cardText(c)));
  const total = showRaw ? (raw ?? []).length : cards.length;
  const count = showRaw ? lines.length : shown.length;

  return (
    <div className="flex flex-col gap-3">
      {live || needle ? (
        <div className="text-muted flex items-center justify-between gap-3 text-xs">
          <output>{needle ? `${count} of ${total} entries match.` : null}</output>
          {live ? (
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="bg-success size-1.5 rounded-full motion-safe:animate-pulse" />
              Live
            </span>
          ) : null}
        </div>
      ) : null}
      {total === 0 ? (
        <p className="text-muted text-sm">
          {showRaw ? "No lines have been logged yet." : "Nothing has been logged yet."}
        </p>
      ) : showRaw ? (
        <ol className="flex flex-col gap-0.5">
          {lines.map((l, i) => (
            <li key={i}>
              <pre dir="ltr" className="font-mono text-xs leading-5 break-all whitespace-pre-wrap">
                {l}
              </pre>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="flex flex-col gap-3">
          {shown.map((c, i) => (
            <li key={`${c.line}:${i}`} data-kind={c.kind} className="min-w-0">
              <CardView card={c} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
