import { Button, Drawer, Tabs, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { nodeView } from "../../-lib/node-view";
import { TAB_LABEL, type Tab, tabsFor } from "../../-lib/tabs";
import type { ParkedView, RunModel, RunNode, RunView } from "../../../../../client";
import { cancelRoleMutation, getDispatchOptions } from "../../../../../client/@tanstack/react-query.gen";
import { ConfirmDelete } from "../../../../../components/confirm-delete/ConfirmDelete";
import { QuestionAnswer } from "../../../../../components/question-answer/QuestionAnswer";
import { StatusChip } from "../../../../../components/status-chip/StatusChip";
import { errorMessage } from "../../../../../lib/api";
import { REASON_TEXT } from "../../../../../lib/park-reasons";
import { invalidateOps } from "../../../../../lib/query";
import { ChangesTab } from "./ChangesTab";
import { ChecksTab } from "./ChecksTab";
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
  const dispatchId = attempt?.dispatchId ?? null;
  const running = attempt?.status === "running";
  const dispatch = useQuery({
    ...getDispatchOptions({ path: { id: runId, dispatchId: dispatchId ?? "" } }),
    enabled: dispatchId !== null,
    refetchInterval: running ? 4000 : false,
  });

  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const live_role = node?.attempts.find((a) => a.status === "running" && a.name);
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
            <Drawer.CloseTrigger />
            {node && Icon ? (
              <>
                <Drawer.Header className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 pe-8">
                    <Icon aria-hidden="true" className="text-muted size-4 shrink-0" />
                    <Drawer.Heading className="min-w-0 truncate">{node.title}</Drawer.Heading>
                    <StatusChip status={node.status} />
                  </div>
                  <p className="text-muted text-sm">{node.now}</p>
                  {live_role && live ? (
                    <div>
                      <Button size="sm" variant="secondary" onPress={() => setConfirming(true)}>
                        Cancel this role
                      </Button>
                    </div>
                  ) : null}
                </Drawer.Header>
                <Drawer.Body className="flex flex-col gap-5">
                  <Question run={run} node={node} />
                  <Tabs
                    variant="secondary"
                    selectedKey={shown}
                    onSelectionChange={(k) => onChange({ tab: String(k) as Tab })}
                  >
                    <Tabs.ListContainer>
                      <Tabs.List aria-label="Details of this step">
                        {tabs.map((t) => (
                          <Tabs.Tab key={t} id={t}>
                            {TAB_LABEL[t]}
                            <Tabs.Indicator />
                          </Tabs.Tab>
                        ))}
                      </Tabs.List>
                    </Tabs.ListContainer>
                    <Tabs.Panel id="overview" className="pt-4">
                      <OverviewTab
                        node={node}
                        attempt={attempt}
                        dispatch={dispatch.data}
                        now={now}
                        onAttempt={(id) => onChange({ attempt: id })}
                      />
                    </Tabs.Panel>
                    <Tabs.Panel id="prompt" className="pt-4">
                      <PromptTab dispatch={dq} />
                    </Tabs.Panel>
                    <Tabs.Panel id="log" className="pt-4">
                      <LogTab runId={runId} dispatchId={dispatchId} live={running && live} />
                    </Tabs.Panel>
                    <Tabs.Panel id="output" className="pt-4">
                      <OutputTab dispatch={dq} />
                    </Tabs.Panel>
                    <Tabs.Panel id="changes" className="pt-4">
                      <ChangesTab runId={runId} model={model} node={node} attempt={attempt} />
                    </Tabs.Panel>
                    <Tabs.Panel id="checks" className="pt-4">
                      <ChecksTab runId={runId} lane={node.lane} />
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
