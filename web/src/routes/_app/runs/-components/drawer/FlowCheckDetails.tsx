import { cn } from "@heroui/react";

import type { FlowCheck } from "../../../../../client";
import { clock, Facts, Section } from "./parts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function FailureList({ title, items, tone }: { title: string; items: string[]; tone: "danger" | "muted" }) {
  if (items.length === 0) return null;
  return (
    <Section title={title} aside={<span className="text-muted text-xs">{items.length}</span>}>
      <ul
        aria-label={title}
        className={cn(
          "divide-separator divide-y rounded-sm border",
          tone === "danger" ? "border-danger/35" : "border-border",
        )}
      >
        {items.map((f, i) => (
          <li
            key={i}
            className={cn(
              "px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap",
              tone === "danger" ? "text-foreground" : "text-muted",
            )}
          >
            {f}
          </li>
        ))}
      </ul>
    </Section>
  );
}

const when = (iso: string | null, none: string) => {
  const t = clock(iso);
  return t && iso ? (
    <time dateTime={iso} className="font-mono text-xs tabular-nums">
      {t}
    </time>
  ) : (
    <span className="text-muted">{none}</span>
  );
};

/** Evidence only: the recorded log path is never treated as a fetch target. */
export function FlowCheckDetails({ check }: { check: FlowCheck }) {
  const code = "font-mono text-xs break-words whitespace-pre-wrap";
  const split =
    check.newFailures === null || check.inheritedFailures === null
      ? null
      : `${plural(check.newFailures, "new failure")} · ${plural(check.inheritedFailures, "inherited failure")}`;
  return (
    <section aria-label="Check details" className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        {split === null ? (
          <p className="text-muted text-sm">Failure split unavailable</p>
        ) : (
          <p className={cn("text-[15px] leading-6", check.newFailures ? "text-danger" : "text-foreground")}>{split}</p>
        )}
        {check.why ? <p className="text-sm leading-6 whitespace-pre-wrap">{check.why}</p> : null}
      </div>
      <FailureList title="Failures" items={check.failures} tone="danger" />
      <FailureList title="Pre-existing failures" items={check.preExisting} tone="muted" />
      <Section title="Details">
        <Facts
          rows={[
            { k: "Command", v: <code className={code}>{check.command}</code> },
            { k: "Scope", v: check.scope },
            { k: "Base", v: check.base ? "Yes" : "No" },
            { k: "Cached", v: check.cached ? "Yes" : "No" },
            { k: "Requested", v: when(check.startedAt, "Timing unknown") },
            { k: "Ended", v: when(check.endedAt, "Running") },
            {
              k: "Exit",
              v: <span className={code}>{check.endedAt ? String(check.exit ?? "Unknown") : "Pending"}</span>,
            },
            { k: "Failures", v: String(check.failureCount ?? "Unknown") },
            { k: "Log path", v: <code className={code}>{check.logPath ?? "Unavailable"}</code> },
          ]}
        />
      </Section>
    </section>
  );
}
