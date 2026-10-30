import { cn } from "@heroui/react";
import type { ReactNode } from "react";

import { formatCost, formatTokens, tokenTotal } from "../../-lib/format";
import { formatDuration, modelName, nowLine, parseRung, STATUS_LABEL } from "../../-lib/node-view";
import type { Attempt, FlowCause, FlowCheck, FlowDispatch, FlowTask, FlowTurn, RunNode } from "../../../../../client";
import { backendName, ProviderIcon } from "../../../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../../../components/status-chip/StatusChip";
import { Term } from "../../../../../components/term/Term";
import { FlowCheckDetails } from "./FlowCheckDetails";
import { clock, type Fact, Facts, Section } from "./parts";

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
  review: "A reviewer reads the work and lists findings as IMPORTANT, NIT or PRE-EXISTING, each with its bug class.",
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

export function RungLine({ rung }: { rung: string }) {
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

const CAUSE: Record<FlowCause["type"], string> = {
  "ledger.changed": "Ledger changed",
  "task.delegated": "Task delegated",
  "check.requested": "Check requested",
};

const mono = "font-mono text-xs tabular-nums";

const stamp = (iso: string | null | undefined) => {
  const t = clock(iso);
  return t && iso ? (
    <time dateTime={iso} className={mono}>
      {t}
    </time>
  ) : null;
};

/** The one line that answers "did it work, and why": what went wrong, or what the step is doing now. */
function Outcome({ node, attempt }: { node: RunNode; attempt: Attempt | undefined }) {
  const failed = attempt?.status === "failed" || node.status === "failed";
  const said = attempt?.text?.trim() || null;
  // "done" under a done attempt says nothing
  const text = said && attempt && said.toLowerCase() !== STATUS_LABEL[attempt.status].toLowerCase() ? said : null;
  // An ended step's now line restates what went wrong; it earns its place while the step runs or waits.
  // The question box above already says what a waiting step waits for.
  const line = node.question || (text && node.status !== "running" && node.status !== "parked") ? null : nowLine(node);
  if (!line && !text) return null;
  const tone = failed ? "border-danger bg-danger/6" : node.status === "running" ? "border-success" : "border-border";
  return (
    <div className={cn("flex flex-col gap-2 border-s-2 py-1 ps-4", tone)}>
      {text ? (
        <div className="flex flex-col gap-1">
          <h3 className={cn("label-caps", failed ? "text-danger" : "text-muted")}>
            {failed ? "What went wrong" : "Note"}
          </h3>
          <p className="text-sm leading-6 break-words whitespace-pre-wrap">{text}</p>
        </div>
      ) : null}
      {line ? (
        <div className="flex flex-col gap-1">
          <h3 className="label-caps text-muted">Now</h3>
          <p className="text-sm leading-6 break-words whitespace-pre-wrap">{line}</p>
        </div>
      ) : null}
    </div>
  );
}

/** Every attempt of the step, newest first; the one on show drives the header and every tab. */
function History({
  node,
  attempt,
  onAttempt,
}: {
  node: RunNode;
  attempt: Attempt | undefined;
  onAttempt: (id: string) => void;
}) {
  return (
    <Section
      title="Attempts"
      label="History"
      aside={<span className="text-muted text-xs">{node.attempts.length}</span>}
    >
      <ul aria-label="Attempts" className="border-border divide-separator divide-y rounded-sm border">
        {node.attempts.map((a, i) => {
          const r = a.rung ? parseRung(a.rung) : null;
          const on = a.id === attempt?.id;
          return (
            <li key={a.id}>
              <button
                type="button"
                aria-current={on ? "true" : undefined}
                onClick={() => onAttempt(a.id)}
                className={cn(
                  "hover:bg-surface-secondary focus-visible:outline-focus relative grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2.5 text-left text-[13px] focus-visible:outline-2 focus-visible:-outline-offset-2",
                  on &&
                    "bg-surface-secondary before:bg-foreground before:absolute before:inset-y-0 before:start-0 before:w-0.5",
                )}
              >
                <span className="text-muted font-mono text-xs tabular-nums">{node.attempts.length - i}</span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate">
                    {a.label}
                    {a.judge ? <span className="text-muted ms-2 text-xs">{a.judge} judge</span> : null}
                    {a.failoverFrom ? <span className="text-warning ms-2 text-xs">stand-in</span> : null}
                  </span>
                  <span className="text-muted flex flex-wrap items-center gap-x-2 text-xs">
                    {r ? (
                      <span className="inline-flex items-center gap-1">
                        <ProviderIcon backend={r.backend} size="xs" />
                        {r.model ? modelName(r.model) : r.backend}
                      </span>
                    ) : null}
                    {stamp(a.at)}
                    {a.secs !== null ? <span className={mono}>{formatDuration(a.secs)}</span> : null}
                    {a.costUsd !== null ? <span className={mono}>{formatCost(a.costUsd)}</span> : null}
                  </span>
                </span>
                <StatusChip status={a.status} label={STATUS_LABEL[a.status]} />
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

export interface FlowContext {
  check: FlowCheck | undefined;
  turn: FlowTurn | undefined;
  causes: FlowCause[];
  task: FlowTask | undefined;
  dispatch: FlowDispatch | undefined;
}

/** Did it work and why first, then what it was asked to do, the details, its attempts, and what the step is. */
export function OverviewTab({
  node,
  attempt,
  flow,
  onAttempt,
}: {
  node: RunNode;
  attempt: Attempt | undefined;
  flow: FlowContext;
  onAttempt: (id: string) => void;
}) {
  const rung = attempt?.rung ?? node.rung;
  const tokens = attempt?.tokens ?? null;
  const d = flow.dispatch;
  const rows: Fact[] = [];
  if (rung) rows.push({ k: "Model", v: <RungLine rung={rung} /> });
  if (d?.climbFrom) rows.push({ k: "Climbed from", v: <span className={mono}>{d.climbFrom}</span> });
  if (attempt?.failoverFrom) rows.push({ k: "Stand-in for", v: <span className={mono}>{attempt.failoverFrom}</span> });
  const started = stamp(attempt?.at ?? node.startedAt);
  const ended = stamp(attempt?.endedAt ?? node.endedAt);
  if (started)
    rows.push({
      k: "When",
      v: (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {started}
          <span className="text-muted">to</span>
          {ended ?? <span className="text-muted text-xs">now</span>}
        </span>
      ),
    });
  if (tokens)
    rows.push({
      k: "Tokens",
      v: (
        <span className={mono}>
          {formatTokens(tokenTotal(tokens))}
          <span className="text-muted">
            {" "}
            · {formatTokens(tokens.input)} in · {formatTokens(tokens.cached)} cached · {formatTokens(tokens.output)} out
          </span>
        </span>
      ),
    });
  if (d) {
    rows.push({ k: "Dispatch", v: <span className={mono}>{d.status}</span> });
    rows.push({ k: "Reply", v: <span className={mono}>{d.replyStatus ?? "Unknown"}</span> });
    if (d.ledgerTask) rows.push({ k: "Ledger task", v: <span className={mono}>{d.ledgerTask}</span> });
  }

  return (
    <>
      <Outcome node={node} attempt={attempt} />
      {flow.check ? <FlowCheckDetails check={flow.check} /> : null}
      {flow.turn ? (
        <Section title="Why this turn" label="Architect turn">
          <p className="text-sm leading-6 whitespace-pre-wrap">{flow.turn.why ?? "No summary recorded."}</p>
          {flow.causes.length > 0 ? (
            <ul className="border-border divide-separator mt-1 divide-y rounded-sm border">
              {flow.causes.map((c) => (
                <li key={c.seq} className="flex flex-col gap-1 px-3 py-2.5">
                  <span className="label-caps text-muted">{CAUSE[c.type]}</span>
                  <p className="text-[13px] leading-5 whitespace-pre-wrap">{c.why}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}
      {flow.task ? (
        <Section title="Goal" label="Ledger goal">
          <p className="text-sm leading-6 whitespace-pre-wrap">{flow.task.goal}</p>
        </Section>
      ) : null}
      {d ? (
        <Section title="Why it was dispatched" label="Dispatch reason">
          <p className="text-sm leading-6 whitespace-pre-wrap">{d.why ?? "No reason recorded."}</p>
        </Section>
      ) : null}
      {rows.length > 0 && !flow.check ? (
        <Section title="Details">
          <Facts rows={rows} />
        </Section>
      ) : null}
      {node.attempts.length > 1 ? <History node={node} attempt={attempt} onAttempt={onAttempt} /> : null}
      <Section title="About this step">
        <p className="text-muted text-[13px] leading-6">{HELP[node.kind]}</p>
      </Section>
    </>
  );
}
