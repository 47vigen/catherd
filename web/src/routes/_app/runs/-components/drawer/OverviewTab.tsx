import { cn } from "@heroui/react";
import type { ReactNode } from "react";

import { formatCost, formatTokens, tokenTotal } from "../../-lib/format";
import { formatDuration, nodeSecs, parseRung } from "../../-lib/node-view";
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="label-caps text-muted">{label}</dt>
      <dd className="min-w-0 text-[13px] break-words">{children}</dd>
    </div>
  );
}

function RungLine({ rung }: { rung: string }) {
  const r = parseRung(rung);
  return (
    <span className="flex items-center gap-2">
      <ProviderIcon backend={r.backend} size="sm" />
      <span>{backendName(rung)}</span>
      <span className="font-mono text-xs">
        {r.model}
        {r.effort ? ` · ${r.effort}` : ""}
      </span>
    </span>
  );
}

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

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm leading-6">{HELP[node.kind]}</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Row label="Now">{node.now}</Row>
        <Row label="Started">{clock(attempt?.at ?? node.startedAt)}</Row>
        <Row label="Ended">{clock(attempt?.endedAt ?? node.endedAt)}</Row>
        <Row label="Took">{secs === null ? "–" : formatDuration(secs)}</Row>
        {rung ? (
          <div className="col-span-2">
            <Row label="Rung">
              <RungLine rung={rung} />
            </Row>
          </div>
        ) : null}
        {dispatch?.route ? (
          <div className="col-span-2">
            <Row label="Why this rung">
              {dispatch.route.why}
              <span className="text-muted block text-xs">
                Chosen by {dispatch.route.decidedBy} from {dispatch.route.source}.
              </span>
            </Row>
          </div>
        ) : null}
        {attempt?.failoverFrom ? (
          <div className="col-span-2">
            <Row label="Stand-in for">
              <span className="font-mono text-xs">{attempt.failoverFrom}</span>
            </Row>
          </div>
        ) : null}
        {tokens ? (
          <Row label="Tokens">
            <span className="font-mono tabular-nums">{formatTokens(tokenTotal(tokens))}</span>
            <span className="text-muted block text-xs">
              {formatTokens(tokens.input)} in, {formatTokens(tokens.output)} out, {formatTokens(tokens.cached)} cached
            </span>
          </Row>
        ) : null}
        {attempt && attempt.costUsd !== null ? (
          <Row label="Cost">
            <span className="font-mono tabular-nums">{formatCost(attempt.costUsd)}</span>
          </Row>
        ) : null}
        {attempt?.text ? (
          <div className="col-span-2">
            <Row label={attempt.status === "failed" ? "What went wrong" : "Note"}>{attempt.text}</Row>
          </div>
        ) : null}
      </dl>
      {node.attempts.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="label-caps text-muted">Attempts</h3>
          <ul aria-label="Attempts" className="border-border bg-surface divide-border divide-y rounded-sm border">
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
