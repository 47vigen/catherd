import { Button, cn, Drawer, Tabs, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { formatDuration, modelName, nodeSecs, nodeView, parseRung, roundsOf, type Tone } from "../../-lib/node-view";
import { TAB_LABEL, type Tab, tabsFor } from "../../-lib/tabs";
import type { Attempt, ParkedView, RunModel, RunNode, RunView } from "../../../../../client";
import { cancelRoleMutation, getDispatchOptions } from "../../../../../client/@tanstack/react-query.gen";
import { ConfirmDelete } from "../../../../../components/confirm-delete/ConfirmDelete";
import { ProviderIcon } from "../../../../../components/provider-icon/ProviderIcon";
import { QuestionAnswer } from "../../../../../components/question-answer/QuestionAnswer";
import { StatusChip } from "../../../../../components/status-chip/StatusChip";
import { errorMessage } from "../../../../../lib/api";
import { REASON_TEXT } from "../../../../../lib/park-reasons";
import { invalidateOps } from "../../../../../lib/query";
import { ChangesTab } from "./ChangesTab";
import { ChecksTab } from "./ChecksTab";
import { FlowCheckDetails } from "./FlowCheckDetails";
import { LogTab } from "./LogTab";
import { OutputTab } from "./OutputTab";
import { OverviewTab } from "./OverviewTab";
import { PromptTab } from "./PromptTab";

/** The question a parked step asks, as the answer box takes it; the run's own record wins when it has one. */
function parkedView(run: RunView, q: NonNullable<RunNode["question"]>, at: string): ParkedView {
  const known = run.parked.find((p) => p.unit === q.unit);
  return (
    known ?? {
      run: run.id,
      runTitle: run.title,
      unit: q.unit,
      question: q.question,
      reason: q.reason,
      at,
      command: `catherd answer ${run.id} ${q.unit}`,
    }
  );
}

function Question({ run, node }: { run: RunView; node: RunNode }) {
  if (!node.question) return null;
  const q = parkedView(run, node.question, node.startedAt ?? run.updatedAt);
  return (
    <section aria-label="Question" className="border-warning bg-warning/8 flex flex-col gap-3 rounded-sm border p-3">
      <h3 className="label-caps text-warning">Waiting for you</h3>
      <p className="text-sm leading-6 break-words whitespace-pre-wrap">{q.question}</p>
      <p className="text-muted text-xs">{REASON_TEXT[q.reason]}</p>
      <QuestionAnswer q={q} />
    </section>
  );
}

const ICON_TILE: Record<Tone, string> = {
  running: "bg-success/15 text-success",
  success: "bg-success/12 text-success",
  danger: "bg-danger/12 text-danger",
  warning: "bg-warning/20 text-warning",
  muted: "bg-surface-tertiary text-muted",
};

/** One short line under the title: who runs the step, on which model, for how long, in which round. */
function Meta({ node, attempt, now }: { node: RunNode; attempt: Attempt | undefined; now: number }) {
  const rung = attempt?.rung ?? (node.kind === "check" ? null : node.rung);
  const r = rung ? parseRung(rung) : null;
  const secs = attempt?.secs ?? nodeSecs(node, now);
  const rounds = roundsOf(node);
  const role = attempt?.role ?? node.role;
  const parts = [
    role ? <span key="role">{role}</span> : null,
    r ? (
      <span key="model" className="inline-flex items-center gap-1.5">
        <ProviderIcon backend={r.backend} size="xs" />
        {r.model ? modelName(r.model) : r.backend}
        {r.effort ? <span className="text-muted">{r.effort}</span> : null}
      </span>
    ) : null,
    secs !== null ? (
      <span key="secs" className="font-mono tabular-nums">
        {formatDuration(secs)}
      </span>
    ) : null,
    rounds > 1 ? <span key="rounds">{rounds} rounds</span> : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {parts.flatMap((p, i) =>
        i === 0
          ? [p]
          : [
              <span key={`dot${i}`} aria-hidden="true">
                ·
              </span>,
              p,
            ],
      )}
    </p>
  );
}

/** A step opened from the graph: its question if it waits, then one tab per kind of detail. */
export function NodeDrawer({
  runId,
  run,
  model,
  nodeId,
  attemptId,
  tab,
  live,
  now,
  onChange,
  onClose,
}: {
  runId: string;
  run: RunView;
  model: RunModel;
  nodeId: string | undefined;
  attemptId: string | undefined;
  tab: Tab;
  live: boolean;
  now: number;
  onChange: (patch: { tab?: Tab; attempt?: string }) => void;
  onClose: () => void;
}) {
  const node = model.nodes.find((n) => n.id === nodeId);
  // The newest attempt that ran a role, else the newest of any kind.
  const attempt =
    node?.attempts.find((a) => a.id === attemptId) ?? node?.attempts.find((a) => a.dispatchId) ?? node?.attempts[0];
  const flowCheck = model.flow?.checks.find((c) => c.selection.nodeId === nodeId);
  const flowTurn = model.flow?.architect.find((t) => t.dispatchId === attempt?.dispatchId);
  const flowDispatch = model.flow?.dispatches.find((d) => d.dispatchId === attempt?.dispatchId);
  const dispatchId = attempt?.dispatchId ?? null;
  const running = attempt?.status === "running";
  const dispatch = useQuery({
    ...getDispatchOptions({ path: { id: runId, dispatchId: dispatchId ?? "" } }),
    enabled: dispatchId !== null,
    refetchInterval: running ? 4000 : false,
  });

  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  // The selected attempt when it is the one running: a review node can run two roles at once.
  const live_role =
    attempt?.status === "running" && attempt.name
      ? attempt
      : node?.attempts.find((a) => a.status === "running" && a.name);
  const cancel = useMutation({
    ...cancelRoleMutation(),
    onSuccess: async () => {
      setConfirming(false);
      toast.success("The role is stopping. The run decides what comes next.");
      await invalidateOps(qc, "getRun", "getRunModel", "getDispatch");
    },
    onError: (e) => toast.danger(errorMessage(e)),
  });

  const tabs = node ? tabsFor(node) : [];
  const shown: Tab = tabs.includes(tab) ? tab : "overview";
  const view = node ? nodeView(node) : null;
  const Icon = view?.icon;
  const dq = dispatchId !== null ? dispatch : null;

  return (
    <>
      <Drawer.Backdrop
        isOpen={node !== undefined}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        variant="transparent"
      >
        <Drawer.Content placement="right">
          <Drawer.Dialog className="w-[min(680px,100vw)] max-w-full">
            {/* On the title row's centre line, not the panel's corner. */}
            <Drawer.CloseTrigger className="top-[22px]" />
            {node && Icon ? (
              <>
                <Drawer.Header className="flex flex-col gap-1.5 pe-8">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-sm",
                        ICON_TILE[view?.tone ?? "muted"],
                      )}
                    >
                      <Icon aria-hidden="true" className="size-4" />
                    </span>
                    <Drawer.Heading className="min-w-0 truncate text-base leading-7">{node.title}</Drawer.Heading>
                    <StatusChip status={node.status} />
                  </div>
                  <Meta node={node} attempt={attempt} now={now} />
                  {live_role && live ? (
                    <div className="pt-1">
                      <Button size="sm" variant="secondary" onPress={() => setConfirming(true)}>
                        Cancel this role
                      </Button>
                    </div>
                  ) : null}
                </Drawer.Header>
                <Drawer.Body className="text-foreground flex flex-col gap-5 pt-4">
                  <Question run={run} node={node} />
                  <Tabs selectedKey={shown} onSelectionChange={(k) => onChange({ tab: String(k) as Tab })}>
                    <Tabs.ListContainer className="w-fit max-w-full">
                      <Tabs.List aria-label="Details of this step" className="p-0.5">
                        {tabs.map((t) => (
                          <Tabs.Tab key={t} id={t} className="h-7 px-3 text-[13px] whitespace-nowrap">
                            {TAB_LABEL[t]}
                            <Tabs.Indicator />
                          </Tabs.Tab>
                        ))}
                      </Tabs.List>
                    </Tabs.ListContainer>
                    <Tabs.Panel id="overview" className="px-0 pt-4 pb-0">
                      {flowCheck ? <FlowCheckDetails check={flowCheck} /> : null}
                      {flowTurn ? (
                        <section aria-label="Architect turn" className="mb-4 flex flex-col gap-3">
                          <h3 className="label-caps text-muted">Summary</h3>
                          <p className="text-sm whitespace-pre-wrap">{flowTurn.why ?? "No summary recorded."}</p>
                          {model.flow?.causes
                            .filter((c) => c.turnDispatchId === flowTurn.dispatchId)
                            .map((c) => (
                              <div key={c.seq}>
                                <h4 className="text-muted font-mono text-xs">{c.type}</h4>
                                <p className="text-sm whitespace-pre-wrap">{c.why}</p>
                              </div>
                            ))}
                        </section>
                      ) : null}
                      {flowDispatch ? (
                        <section aria-label="Dispatch reason" className="mb-4 text-sm">
                          <p className="whitespace-pre-wrap">{flowDispatch.why ?? "No reason recorded."}</p>
                          <p className="text-muted mt-2 font-mono text-xs">
                            Status: {flowDispatch.status} · Reply: {flowDispatch.replyStatus ?? "Unknown"}
                            {flowDispatch.ledgerTask ? ` · Ledger task: ${flowDispatch.ledgerTask}` : ""}
                          </p>
                        </section>
                      ) : null}
                      {flowCheck ? null : (
                        <OverviewTab
                          node={node}
                          attempt={attempt}
                          now={now}
                          onAttempt={(id) => onChange({ attempt: id })}
                        />
                      )}
                    </Tabs.Panel>
                    <Tabs.Panel id="prompt" className="px-0 pt-4 pb-0">
                      <PromptTab dispatch={dq} />
                    </Tabs.Panel>
                    <Tabs.Panel id="log" className="px-0 pt-4 pb-0">
                      <LogTab runId={runId} dispatchId={dispatchId} live={running && live} />
                    </Tabs.Panel>
                    <Tabs.Panel id="output" className="px-0 pt-4 pb-0">
                      <OutputTab dispatch={dq} />
                    </Tabs.Panel>
                    <Tabs.Panel id="changes" className="px-0 pt-4 pb-0">
                      <ChangesTab runId={runId} model={model} node={node} attempt={attempt} />
                    </Tabs.Panel>
                    <Tabs.Panel id="checks" className="px-0 pt-4 pb-0">
                      <ChecksTab runId={runId} lane={node.lane} check={flowCheck} />
                    </Tabs.Panel>
                  </Tabs>
                </Drawer.Body>
              </>
            ) : null}
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
      <ConfirmDelete
        title={`Cancel ${live_role?.name ?? "this role"}?`}
        body="The role stops now and the run decides what comes next."
        confirmLabel="Cancel role"
        cancelLabel="Keep running"
        isOpen={confirming && live_role !== undefined}
        isPending={cancel.isPending}
        onConfirm={() => live_role?.name && cancel.mutate({ path: { id: runId, name: live_role.name } })}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
