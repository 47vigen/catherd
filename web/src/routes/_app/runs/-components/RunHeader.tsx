import { ArrowLeft } from "@gravity-ui/icons";
import { Button, Link, toast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { formatCost, formatTokens, totalsOf } from "../-lib/format";
import { timeSplit } from "../-lib/insights";
import { ledgerTasks } from "../-lib/ledger";
import { formatDuration } from "../-lib/node-view";
import { runStatus } from "../-lib/run-status";
import type { RunModel, RunView } from "../../../../client";
import { cancelRunMutation, pauseRunMutation, resumeRunMutation } from "../../../../client/@tanstack/react-query.gen";
import { ConfirmDelete } from "../../../../components/confirm-delete/ConfirmDelete";
import { PageHeader } from "../../../../components/page-header/PageHeader";
import { type Status, StatusChip } from "../../../../components/status-chip/StatusChip";
import { Tile } from "../../../../components/tile/Tile";
import { errorMessage } from "../../../../lib/api";
import { invalidateOps } from "../../../../lib/query";

const STATUS_WORD: Partial<Record<Status, string>> = { info: "Finished", parked: "Waiting" };
const STATUS_TEXT: Partial<Record<Status, string>> = {
  running: "text-success",
  done: "text-success",
  failed: "text-danger",
  parked: "text-warning",
  paused: "text-warning",
  planning: "text-warning",
  approval: "text-warning",
};
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const valid = (d: Date) => !Number.isNaN(d.getTime());

/** Title, repo and controls of the run, then its figures as one stat sheet. */
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
      toast.success("Paused. Live roles finish; nothing new starts or lands.");
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
  const status: Status = paused ? "paused" : runStatus(run);
  const word = STATUS_WORD[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
  const dispatches = model?.dispatches ?? [];
  const totals = totalsOf(dispatches);
  const started = new Date(run.startedAt);
  const ended = new Date(live ? now.getTime() : Date.parse(run.updatedAt));
  // the server leaves pauses out; a live run with no pause open counts on from that read
  const elapsed =
    run.elapsedSec +
    (live && run.countingSince ? Math.max(0, now.getTime() - Date.parse(run.countingSince)) / 1000 : 0);
  const tokensIn = dispatches.reduce((a, d) => a + (d.tokens?.input ?? 0), 0);
  const cacheRead = dispatches.reduce((a, d) => a + (d.tokens?.cached ?? 0), 0);
  const cacheWrite = dispatches.reduce((a, d) => a + (d.tokens?.cacheWrite ?? 0), 0);
  const tokensOut = dispatches.reduce((a, d) => a + (d.tokens?.output ?? 0), 0);
  const milestones = run.milestones.length;
  // An architect run's ledger is its plan; only a legacy run still has milestones. The model arrives a beat after the
  // run itself, and the server derives a 2.0 run's milestones from its ledger, so the count is right before the flow loads.
  const architect = run.engine === "2.0";
  const tasks = model?.flow ? model.flow.tasks.length : milestones;
  // The server counts every review round; summing the ledger's own rows can miss a task the architect has replaced.
  // The flow's own idle spans, so the header and the time bar never disagree; the server's figure otherwise.
  const split = model?.flow ? timeSplit(model.flow, now.getTime()) : null;
  const idle = split
    ? split.wallMs > 0
      ? 1 - (split.parts.find((p) => p.key === "working")?.ms ?? 0) / split.wallMs
      : null
    : run.metrics
      ? run.metrics.idlePct / 100
      : null;
  const rounds = run.metrics ? run.metrics.rounds.total : run.milestones.reduce((s, m) => s + m.reviews, 0);

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
        description={
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 font-mono text-xs">
            <span>{run.id}</span>
            <span aria-hidden="true">·</span>
            <span title={run.repo} className="min-w-0 truncate">
              {run.repo.split("/").filter(Boolean).at(-1) ?? run.repo}
            </span>
            {valid(started) ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  started {day.format(started)}, {clock.format(started)}
                </span>
              </>
            ) : null}
          </span>
        }
        actions={
          live ? (
            <>
              {run.engine === "2.0" ? (
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
              <Button size="sm" variant="secondary" onPress={() => setConfirming(true)}>
                Cancel run
              </Button>
            </>
          ) : null
        }
      />
      <Tile.Stats>
        <Tile.Stat
          label="Status"
          value={<span className={STATUS_TEXT[status]}>{word}</span>}
          hint={
            run.holds.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {run.holds.map((h) => (
                  <StatusChip key={h.quota} status="held" label={h.quota} until={h.until} />
                ))}
              </span>
            ) : live ? (
              (run.last ?? undefined)
            ) : undefined
          }
        />
        <Tile.Stat
          label={live ? "Running for" : "Took"}
          value={Number.isNaN(elapsed) ? "–" : formatDuration(elapsed)}
          hint={
            run.waitingSec > 0
              ? `waiting on you ${formatDuration(run.waitingSec)}`
              : live
                ? "So far"
                : valid(ended)
                  ? `Ended ${clock.format(ended)}`
                  : undefined
          }
        />
        <Tile.Stat
          label="Cost"
          value={formatCost(totals.costUsd)}
          hint={
            <span
              title={
                totals.tokens > 0
                  ? `${formatTokens(tokensIn - cacheRead - cacheWrite)} uncached · ${formatTokens(cacheRead)} cache read · ${formatTokens(cacheWrite)} cache write · ${formatTokens(tokensOut)} out`
                  : undefined
              }
            >
              {formatTokens(totals.tokens)} tokens · {dispatches.length}{" "}
              {dispatches.length === 1 ? "role run" : "role runs"}
              {totals.unpriced > 0 ? ` · ${totals.unpriced} unpriced` : ""}
            </span>
          }
        />
        <Tile.Stat
          label={architect ? "Tasks" : "Milestones"}
          value={
            architect && model?.flow && tasks > 0 ? (
              <>
                {model.flow.tasks.filter((t) => t.state === "done").length}
                <span className="text-muted text-lg"> / {tasks}</span>
              </>
            ) : architect ? (
              "–"
            ) : (
              milestones
            )
          }
          hint={architect ? (tasks > 0 ? `done of ${ledgerTasks(tasks)}` : "no ledger yet") : undefined}
        />
        <Tile.Stat
          label="Rounds"
          value={rounds}
          hint={
            run.metrics && run.metrics.rounds.total > 0 ? `at most ${run.metrics.rounds.max} on one task` : undefined
          }
        />
        <Tile.Stat
          label="Idle"
          value={idle === null ? "–" : `${Math.round(idle * 100)}%`}
          hint={run.metrics ? `${run.metrics.concurrency.toFixed(2)} roles at once on average` : undefined}
        />
      </Tile.Stats>
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
