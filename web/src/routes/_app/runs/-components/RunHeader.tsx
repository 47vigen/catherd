import { ArrowLeft } from "@gravity-ui/icons";
import { Button, Link, toast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { formatCost, formatTokens, totalsOf } from "../-lib/format";
import { formatDuration } from "../-lib/node-view";
import { runStatus } from "../-lib/run-status";
import type { RunModel, RunView } from "../../../../client";
import { cancelRunMutation, pauseRunMutation, resumeRunMutation } from "../../../../client/@tanstack/react-query.gen";
import { ConfirmDelete } from "../../../../components/confirm-delete/ConfirmDelete";
import { PageHeader } from "../../../../components/page-header/PageHeader";
import { StatusChip } from "../../../../components/status-chip/StatusChip";
import { errorMessage } from "../../../../lib/api";
import { invalidateOps } from "../../../../lib/query";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="label-caps text-muted">{label}</dt>
      <dd className="font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

/** Title, repo, status, time, tokens and cost of the run, and its controls. */
export function RunHeader({
  run,
  model,
  live,
  now,
}: {
  run: RunView;
  model: RunModel | undefined;
  live: boolean;
  now: Date;
}) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const refresh = () => invalidateOps(qc, "getRun", "getRunModel", "listRuns");
  const cancel = useMutation({
    ...cancelRunMutation(),
    onSuccess: async () => {
      setConfirming(false);
      toast.success("Cancelling. Live roles are being stopped.");
      await refresh();
    },
    onError: (e) => toast.danger(errorMessage(e)),
  });
  const pause = useMutation({
    ...pauseRunMutation(),
    onSuccess: async () => {
      toast.success("Paused. Live roles finish; nothing new starts.");
      await refresh();
    },
    onError: (e) => toast.danger(errorMessage(e)),
  });
  const resume = useMutation({
    ...resumeRunMutation(),
    onSuccess: async () => {
      toast.success("Resumed. The held steps start again.");
      await refresh();
    },
    onError: (e) => toast.danger(errorMessage(e)),
  });

  const paused = live && run.paused !== null;
  const totals = totalsOf(model?.dispatches ?? []);
  const end = live ? now.getTime() : Date.parse(run.updatedAt);
  const elapsed = (end - Date.parse(run.startedAt)) / 1000;

  return (
    <>
      <PageHeader
        before={
          <Link href="/runs" className="text-muted hover:text-foreground w-fit gap-1.5 text-sm no-underline">
            <ArrowLeft aria-hidden="true" className="size-4" />
            Runs
          </Link>
        }
        title={run.title}
        description={`${run.id} · ${run.repo}`}
        actions={
          <>
            <StatusChip status={paused ? "paused" : runStatus(run)} />
            {live && run.engine === "2.0" ? (
              paused ? (
                <Button
                  size="sm"
                  variant="secondary"
                  isPending={resume.isPending}
                  onPress={() => resume.mutate({ path: { id: run.id } })}
                >
                  Resume
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  isPending={pause.isPending}
                  onPress={() => pause.mutate({ path: { id: run.id } })}
                >
                  Pause
                </Button>
              )
            ) : null}
            {live ? (
              <Button size="sm" variant="secondary" onPress={() => setConfirming(true)}>
                Cancel run
              </Button>
            ) : null}
          </>
        }
      />
      <dl className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <Stat label={live ? "Running for" : "Took"} value={Number.isNaN(elapsed) ? "–" : formatDuration(elapsed)} />
        <Stat label="Tokens" value={formatTokens(totals.tokens)} />
        <Stat label="Cost" value={formatCost(totals.costUsd)} />
        {run.holds.map((h) => (
          <div key={h.quota} className="flex flex-col gap-0.5">
            <dt className="label-caps text-muted">{h.quota}</dt>
            <dd>
              <StatusChip status="held" until={h.until} />
            </dd>
          </div>
        ))}
      </dl>
      <ConfirmDelete
        title={`Cancel ${run.title}?`}
        body="Every live role is stopped and the run ends. It cannot be resumed."
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        isOpen={confirming}
        isPending={cancel.isPending}
        onConfirm={() => cancel.mutate({ path: { id: run.id } })}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
