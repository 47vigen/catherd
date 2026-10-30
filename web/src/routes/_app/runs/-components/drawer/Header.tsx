import { Button, cn, Drawer } from "@heroui/react";
import type { ReactNode } from "react";

import { formatCost, formatTokens, tokenTotal } from "../../-lib/format";
import { formatDuration, modelName, nodeSecs, nodeView, parseRung, STATUS_LABEL } from "../../-lib/node-view";
import type { Attempt, FlowCheck, RunNode } from "../../../../../client";
import { ProviderIcon } from "../../../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../../../components/status-chip/StatusChip";
import { clock } from "./parts";

// The run page's role palette, so a step reads as the same colour on the flow chart and in its drawer.
const ROLE_TILE: Record<string, string> = {
  architect: "bg-chart-4/14 text-chart-4",
  worker: "bg-chart-1/14 text-chart-1",
  writer: "bg-chart-1/14 text-chart-1",
  artist: "bg-chart-1/14 text-chart-1",
  reviewer: "bg-chart-2/14 text-chart-2",
  verifier: "bg-chart-2/14 text-chart-2",
  researcher: "bg-chart-3/16 text-chart-3",
};
const KIND_ROLE: Partial<Record<RunNode["kind"], string>> = {
  architect: "architect",
  lane: "worker",
  review: "reviewer",
  verify: "verifier",
};
const tileOf = (role: string | null, kind: RunNode["kind"]) =>
  ROLE_TILE[role ?? ""] ?? ROLE_TILE[KIND_ROLE[kind] ?? ""] ?? "bg-surface-secondary text-muted";

const KIND_LABEL: Record<RunNode["kind"], string> = {
  start: "Start",
  architect: "Architect",
  later: "Milestones",
  route: "Route",
  preflight: "Preflight",
  lane: "Lane",
  check: "Check",
  commit: "Commit",
  review: "Review",
  verify: "Verify",
  integrate: "Integrate",
  land: "Land",
  judge: "Judge",
  report: "Report",
  end: "End",
};

export const VERDICT: Record<NonNullable<FlowCheck["verdict"]>, { text: string; tone: string }> = {
  pass: { text: "Passed", tone: "text-success" },
  new: { text: "New failures", tone: "text-danger" },
  inherited: { text: "Inherited only", tone: "text-warning" },
  unknown: { text: "Unknown", tone: "text-muted" },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Fact = { label: string; value: ReactNode; title?: string; tone?: string };

/** The four figures a person checks first: how long, and what it cost or what the check said. */
function figures(node: RunNode, attempt: Attempt | undefined, check: FlowCheck | undefined, now: number): Fact[] {
  const secs = attempt?.secs ?? nodeSecs(node, now);
  const took: Fact = {
    label: node.status === "running" ? "Running for" : "Took",
    value: secs === null ? null : formatDuration(secs),
  };
  const started: Fact = {
    label: "Started",
    value: clock(attempt?.at ?? node.startedAt),
  };
  if (check) {
    const verdict = check.verdict ? VERDICT[check.verdict] : null;
    return [
      {
        label: "Verdict",
        value: verdict?.text ?? (check.endedAt ? "Unknown" : "Running"),
        tone: verdict?.tone,
      },
      {
        label: "Exit",
        value: check.endedAt ? String(check.exit ?? "–") : null,
      },
      {
        label: "Failures",
        value: check.failureCount === null ? null : String(check.failureCount),
      },
      took,
    ];
  }
  if (node.kind === "check") {
    const exit = attempt?.exit ?? null;
    return [
      took,
      {
        label: "Exit",
        value: exit === null ? null : String(exit),
        tone: exit ? "text-danger" : undefined,
      },
      started,
      { label: "Ended", value: clock(attempt?.endedAt ?? node.endedAt) },
    ];
  }
  const tokens = attempt?.tokens ?? null;
  return [
    took,
    {
      label: "Tokens",
      value: tokens ? formatTokens(tokenTotal(tokens)) : null,
      title: tokens ? `${tokens.input} in (${tokens.cached} cached), ${tokens.output} out` : undefined,
    },
    {
      label: "Cost",
      value: attempt?.costUsd == null ? null : formatCost(attempt.costUsd),
    },
    started,
  ];
}

function Figures({ facts }: { facts: Fact[] }) {
  if (facts.every((f) => f.value === null)) return null;
  return (
    <dl
      aria-label="Figures"
      className="bg-border border-border grid grid-cols-2 gap-px overflow-hidden rounded-sm border sm:grid-cols-4"
    >
      {facts.map((f) => (
        <div key={f.label} className="bg-overlay flex min-w-0 flex-col gap-1 px-3 py-2.5">
          <dt className="label-caps text-muted">{f.label}</dt>
          <dd
            title={f.title}
            className={cn(
              "truncate font-mono text-[15px] leading-6 tracking-[-0.01em] tabular-nums",
              f.value === null ? "text-muted" : f.tone,
            )}
          >
            {f.value ?? "–"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Who runs the step, on which model and effort; the attempt on show when the step has had more than one. */
function Identity({ node, attempt }: { node: RunNode; attempt: Attempt | undefined }) {
  const rung = attempt?.rung ?? (node.kind === "check" ? null : node.rung);
  const r = rung ? parseRung(rung) : null;
  const role = attempt?.role ?? node.role;
  const parts = [
    <span key="kind">{role ? cap(role) : KIND_LABEL[node.kind]}</span>,
    attempt?.name ? (
      <span key="name" className="font-mono">
        {attempt.name}
      </span>
    ) : null,
    r ? (
      <span key="model" className="text-foreground inline-flex items-center gap-1.5">
        <ProviderIcon backend={r.backend} size="xs" />
        {r.model ? modelName(r.model) : r.backend}
        {r.effort ? <span className="text-muted">{r.effort}</span> : null}
      </span>
    ) : null,
    node.attempts.length > 1 && attempt ? (
      <span key="attempt" className="tabular-nums">
        Attempt {node.attempts.length - node.attempts.indexOf(attempt)} of {node.attempts.length}
      </span>
    ) : null,
  ].filter(Boolean);
  return (
    <p className="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {parts.flatMap((p, i) =>
        i === 0
          ? [p]
          : [
              <span key={`dot${i}`} aria-hidden="true" className="text-border">
                /
              </span>,
              p,
            ],
      )}
    </p>
  );
}

/** Identity, status and the figures; the one action a running role offers sits on the status row. */
export function Header({
  divided,
  node,
  attempt,
  check,
  now,
  cancel,
}: {
  /** draws the rule the tab bar would, when there is only one tab and the bar is hidden */
  divided: boolean;
  node: RunNode;
  attempt: Attempt | undefined;
  check: FlowCheck | undefined;
  now: number;
  /** set while a role of this step runs and can be stopped */
  cancel?: { name: string | null; onPress: () => void };
}) {
  const view = nodeView(node);
  const Icon = view.icon;
  return (
    <Drawer.Header className={cn("flex flex-col gap-4 px-5 pt-5 pb-4 sm:px-6", divided && "border-border border-b")}>
      <div className="flex min-w-0 items-start gap-3 pe-8">
        <span
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-sm",
            tileOf(attempt?.role ?? node.role, node.kind),
          )}
        >
          <Icon aria-hidden="true" className="size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <Drawer.Heading className="min-w-0 truncate text-[17px] leading-6 tracking-[-0.01em]">
              {node.title}
            </Drawer.Heading>
            <StatusChip status={node.status} label={STATUS_LABEL[node.status]} />
          </div>
          <Identity node={node} attempt={attempt} />
        </div>
      </div>
      <Figures facts={figures(node, attempt, check, now)} />
      {cancel ? (
        <div className="border-border bg-overlay flex items-center justify-between gap-3 rounded-sm border px-3 py-2">
          <span className="text-muted flex items-center gap-2 text-[13px]">
            <span aria-hidden="true" className="bg-success size-1.5 rounded-full motion-safe:animate-pulse" />
            <span className="text-foreground font-mono">{cancel.name ?? "The role"}</span> is working.
          </span>
          <Button size="sm" variant="danger-soft" onPress={cancel.onPress}>
            Cancel this role
          </Button>
        </div>
      ) : null}
    </Drawer.Header>
  );
}
