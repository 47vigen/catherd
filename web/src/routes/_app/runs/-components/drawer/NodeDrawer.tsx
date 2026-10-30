import { Drawer, Tabs, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { TAB_LABEL, type Tab, tabsFor } from "../../-lib/tabs";
import type { ParkedView, RunModel, RunNode, RunView } from "../../../../../client";
import { cancelRoleMutation, getDispatchOptions } from "../../../../../client/@tanstack/react-query.gen";
import { ConfirmDelete } from "../../../../../components/confirm-delete/ConfirmDelete";
import { QuestionAnswer } from "../../../../../components/question-answer/QuestionAnswer";
import { errorMessage } from "../../../../../lib/api";
import { REASON_TEXT } from "../../../../../lib/park-reasons";
import { invalidateOps } from "../../../../../lib/query";
import { ChangesTab } from "./ChangesTab";
import { ChecksTab } from "./ChecksTab";
import { Header } from "./Header";
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

/** The step waits for the owner: the question, why it was asked, and the ways to answer, above every tab. */
function Question({ run, node }: { run: RunView; node: RunNode }) {
  if (!node.question) return null;
  const q = parkedView(run, node.question, node.startedAt ?? run.updatedAt);
  return (
    <section aria-label="Question" className="border-warning/45 bg-warning/6 flex flex-col rounded-sm border">
      <header className="border-warning/25 flex items-center gap-2 border-b px-4 py-2.5">
        <span aria-hidden="true" className="bg-warning size-1.5 rounded-full motion-safe:animate-pulse" />
        <h3 className="label-caps text-warning">Waiting for your answer</h3>
      </header>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-foreground text-[15px] leading-6 break-words whitespace-pre-wrap">{q.question}</p>
        <p className="text-muted text-xs">{REASON_TEXT[q.reason]}</p>
        <QuestionAnswer q={q} />
      </div>
    </section>
  );
}

/** A step opened from the graph: who and what it is with its figures, its question if it waits, then one tab per kind of detail. */
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
  const flowTask = model.flow?.tasks.find((t) => t.id === flowDispatch?.ledgerTask);
  const dispatchId = attempt?.dispatchId ?? null;
  const running = attempt?.status === "running";
  const dispatch = useQuery({
    ...getDispatchOptions({
      path: { id: runId, dispatchId: dispatchId ?? "" },
    }),
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

  const tabs = node ? tabsFor(node, flowCheck !== undefined) : [];
  const shown: Tab = tabs.includes(tab) ? tab : "overview";
  const dq = dispatchId !== null ? dispatch : null;
  const panel = "flex flex-col gap-6 px-0 pt-5 pb-8";

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
          <Drawer.Dialog className="border-border w-[min(720px,100vw)] max-w-full border-s p-0">
            {/* On the title's centre line, not the panel's corner. */}
            <Drawer.CloseTrigger className="end-4 top-6" />
            {node ? (
              <Tabs
                variant="secondary"
                selectedKey={shown}
                onSelectionChange={(k) => onChange({ tab: String(k) as Tab })}
                className="flex min-h-0 flex-1 flex-col gap-0"
              >
                <Header
                  divided={tabs.length < 2}
                  node={node}
                  attempt={attempt}
                  check={flowCheck}
                  now={now}
                  cancel={
                    live_role && live
                      ? {
                          name: live_role.name,
                          onPress: () => setConfirming(true),
                        }
                      : undefined
                  }
                />
                <Tabs.ListContainer className={tabs.length > 1 ? "px-5 sm:px-6" : "hidden"}>
                  <Tabs.List aria-label="Details of this step" className="w-fit gap-1">
                    {tabs.map((t) => (
                      <Tabs.Tab key={t} id={t} className="h-10 w-auto flex-none px-2.5 text-[13px] whitespace-nowrap">
                        {TAB_LABEL[t]}
                        <Tabs.Indicator className="bg-foreground" />
                      </Tabs.Tab>
                    ))}
                  </Tabs.List>
                </Tabs.ListContainer>
                <Drawer.Body className="text-foreground m-0 flex flex-col px-5 pt-5 sm:px-6">
                  <Question run={run} node={node} />
                  <Tabs.Panel id="overview" className={panel}>
                    <OverviewTab
                      node={node}
                      attempt={attempt}
                      flow={{
                        check: flowCheck,
                        turn: flowTurn,
                        causes: model.flow?.causes.filter((c) => c.turnDispatchId === flowTurn?.dispatchId) ?? [],
                        task: flowTask,
                        dispatch: flowDispatch,
                      }}
                      onAttempt={(id) => onChange({ attempt: id })}
                    />
                  </Tabs.Panel>
                  <Tabs.Panel id="prompt" className={panel}>
                    <PromptTab dispatch={dq} />
                  </Tabs.Panel>
                  <Tabs.Panel id="log" className={panel}>
                    <LogTab runId={runId} dispatchId={dispatchId} live={running && live} />
                  </Tabs.Panel>
                  <Tabs.Panel id="output" className={panel}>
                    <OutputTab dispatch={dq} />
                  </Tabs.Panel>
                  <Tabs.Panel id="changes" className={panel}>
                    <ChangesTab runId={runId} model={model} node={node} attempt={attempt} />
                  </Tabs.Panel>
                  <Tabs.Panel id="checks" className={panel}>
                    <ChecksTab runId={runId} lane={node.lane} />
                  </Tabs.Panel>
                </Drawer.Body>
              </Tabs>
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
