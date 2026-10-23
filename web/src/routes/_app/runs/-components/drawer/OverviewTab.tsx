import { cn } from "@heroui/react";
import type { ReactNode } from "react";

import { formatCost, formatTokens, tokenTotal } from "../../-lib/format";
import { formatDuration, modelName, nodeSecs, nowLine, parseRung } from "../../-lib/node-view";
import type { Attempt, DispatchDetail, RunNode } from "../../../../../client";
import { backendName, ProviderIcon } from "../../../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../../../components/status-chip/StatusChip";
import { Term } from "../../../../../components/term/Term";

// What each kind of step is, in plain words, with the glossary words as hover terms.
const HELP: Record<RunNode["kind"], ReactNode> = {
  start: "The run begins here, with the task you gave catherd.",
  architect: "The architect reads your task and writes the plan: the milestones, their lanes and the checks.",
  later: "The milestones are not known yet. They appear here once the plan is ready.",
  route: (
    <>
      Picks the <Term name="rung">rung</Term> each lane of this milestone runs on.
    </>
  ),
  preflight: "Checks that the base tree is clean and ready before any worker starts on this milestone.",
  lane: (
    <>
      A worker builds one <Term name="lane">lane</Term> of the milestone on its own files. A failed check sends it back
      for a fix <Term name="round">round</Term>.
    </>
  ),
  check: (
    <>
      The <Term name="fast check">fast check</Term>: a quick lint and type check the lane must pass before the work is
      committed.
    </>
  ),
  commit: "The changes of the milestone are committed once every lane has passed its fast check.",
  review: "A reviewer reads the commit and lists findings as BLOCKER, BUG or NIT.",
  verify: (
    <>
      The <Term name="verifier">verifier</Term> checks the finished work against the plan and its{" "}
      <Term name="A-line">A-lines</Term>.
    </>
  ),
  integrate: "Brings the milestone together with the base branch when the base has moved.",
  land: "The milestone lands on the base branch.",
  judge: (
    <>
      The rules <Term name="judge">judge</Term> decides whether the whole run keeps its rules.
    </>
  ),
  report: "The final report of the run is written.",
  end: "The run ends here.",
};

const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const clock = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? time.format(new Date(iso)) : "–");

// A hairline sheet of figures: label over value, cells split by 1px rules, the way the run's stat sheet reads.
function Cell({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn("bg-surface flex min-w-0 flex-col gap-1 px-3 py-2.5", wide && "col-span-full")}>
      <dt className="label-caps text-muted">{label}</dt>
      <dd className="min-w-0 text-[13px] leading-5 break-words">{children}</dd>
    </div>
  );
}

function RungLine({ rung }: { rung: string }) {
  const r = parseRung(rung);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <ProviderIcon backend={r.backend} size="xs" />
      <span className="font-medium">{r.model ? modelName(r.model) : backendName(rung)}</span>
      {r.effort ? <span className="text-muted">{r.effort}</span> : null}
      <span className="text-muted text-xs">on {backendName(rung)}</span>
    </span>
  );
}

const mono = "font-mono tabular-nums";

/** What the step is, where it stands, who runs it and why, what it cost, and the attempts it made. */
export function OverviewTab({
  node,
  attempt,
  dispatch,
  now,
  onAttempt,
}: {
  node: RunNode;
  attempt: Attempt | undefined;
  dispatch: DispatchDetail | undefined;
  now: number;
  onAttempt: (id: string) => void;
}) {
  const secs = attempt?.secs ?? nodeSecs(node, now);
  const rung = attempt?.rung ?? node.rung;
  const tokens = attempt?.tokens ?? null;
  const line = nowLine(node);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted text-sm leading-6">{HELP[node.kind]}</p>
      <dl className="bg-border border-border grid grid-cols-2 gap-px overflow-hidden rounded-sm border sm:grid-cols-4">
        <Cell label="Started">
          <span className={mono}>{clock(attempt?.at ?? node.startedAt)}</span>
        </Cell>
        <Cell label="Ended">
          <span className={mono}>{clock(attempt?.endedAt ?? node.endedAt)}</span>
        </Cell>
        <Cell label="Took">
          <span className={mono}>{secs === null ? "–" : formatDuration(secs)}</span>
        </Cell>
        <Cell label="Tokens">
          {tokens ? (
            <span className={mono} title={`${tokens.input} in, ${tokens.output} out, ${tokens.cached} cached`}>
              {formatTokens(tokenTotal(tokens))}
              {attempt && attempt.costUsd !== null ? (
                <span className="text-muted"> · {formatCost(attempt.costUsd)}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted">–</span>
          )}
        </Cell>
        {line ? (
          <Cell label="Now" wide>
            {line}
          </Cell>
        ) : null}
        {rung ? (
          <Cell label="Model" wide>
            <RungLine rung={rung} />
          </Cell>
        ) : null}
        {dispatch?.route ? (
          <Cell label="Why this model" wide>
            {dispatch.route.why}
            <span className="text-muted block text-xs">
              Chosen by {dispatch.route.decidedBy} from {dispatch.route.source}.
            </span>
          </Cell>
        ) : null}
        {attempt?.failoverFrom ? (
          <Cell label="Stand-in for" wide>
            <span className="font-mono text-xs">{attempt.failoverFrom}</span>
          </Cell>
        ) : null}
        {attempt?.text ? (
          <Cell label={attempt.status === "failed" ? "What went wrong" : "Note"} wide>
            {attempt.text}
          </Cell>
        ) : null}
      </dl>
      {node.attempts.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="label-caps text-muted">Attempts</h3>
          <ul aria-label="Attempts" className="border-border bg-surface divide-separator divide-y rounded-sm border">
            {node.attempts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  aria-current={a.id === attempt?.id ? "true" : undefined}
                  onClick={() => onAttempt(a.id)}
                  className={cn(
                    "hover:bg-surface-secondary focus-visible:outline-focus flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] focus-visible:outline-2 focus-visible:-outline-offset-2",
                    a.id === attempt?.id && "bg-surface-secondary",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {a.label}
                    {a.judge ? <span className="text-muted ms-2 text-xs">{a.judge} judge</span> : null}
                    {a.failoverFrom ? <span className="text-muted ms-2 text-xs">stand-in</span> : null}
                  </span>
                  {a.secs !== null ? (
                    <span className="text-muted font-mono text-xs tabular-nums">{formatDuration(a.secs)}</span>
                  ) : null}
                  <StatusChip status={a.status} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
