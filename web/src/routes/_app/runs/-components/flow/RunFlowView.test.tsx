import { fireEvent, render, screen, within } from "@testing-library/react";

import { at, flowFixture } from "../../-lib/flow.fixture";
import type { FlowSelection, RunView } from "../../../../../client";
import { RunFlowView } from "./RunFlowView";

const run = { id: "r1", phase: "ended", outcome: "done", metrics: null } as RunView;
test("ledger order, dependencies, role markers and overlapping keyboard targets", () => {
  const onOpen = vi.fn<(selection: FlowSelection) => void>();
  render(<RunFlowView flow={flowFixture()} run={run} now={Date.parse(at(150))} onOpen={onOpen} />);
  const view = screen.getByRole("region", { name: "Run flow" });
  expect(
    within(view)
      .getAllByText(/^L[1-8]$/)
      .map((n) => n.textContent),
  ).toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"]);
  expect(screen.getByText("Task goal 8")).toBeVisible();
  expect(screen.getAllByText("Depends on L1")).toHaveLength(7);
  expect(screen.getByText("Unassigned roles")).toBeVisible();
  expect(screen.getByText("Run checks")).toBeVisible();
  const bars = within(view).getAllByRole("button");
  expect(bars[0]).toHaveAccessibleName(/architect-1/);
  const cancelled = screen.getByRole("button", { name: /T2 reviewer/ });
  expect(cancelled).toHaveAttribute("data-tone", "danger");
  expect(screen.getByRole("button", { name: /T3 worker/ })).toHaveAttribute("data-tone", "warning");
  expect(screen.getByText(/Rung changed/)).toBeVisible();
  fireEvent.keyDown(cancelled, { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith({ nodeId: "task/T2", attemptId: "D2" });
  fireEvent.focus(cancelled);
  expect(screen.getByRole("tooltip")).toHaveTextContent(/reviewer.*codex:model#high.*cancelled.*20s/);
  expect(screen.getByRole("button", { name: /C1/ })).toHaveAttribute("data-tone", "danger");
  expect(screen.getByText("Gap")).toBeVisible();
});
test("empty flow and unavailable metrics render without inventing activity", () => {
  const flow = { ...flowFixture(), architect: [], tasks: [], dispatches: [], checks: [], idle: [] };
  render(<RunFlowView flow={flow} run={run} now={0} onOpen={vi.fn<(selection: FlowSelection) => void>()} />);
  expect(screen.getByText("No activity recorded yet.")).toBeVisible();
  expect(within(screen.getByLabelText("Flow rows")).getByText("Idle")).toBeVisible();
  expect(screen.queryByRole("button", { name: /T1/ })).not.toBeInTheDocument();
});

test("statistics use Metrics values directly and timing-unknown checks remain selectable", () => {
  const flow = flowFixture();
  flow.checks[0] = { ...flow.checks[0]!, startedAt: null, verdict: "inherited", exit: null };
  const metrics = {
    wallMin: 5,
    idlePct: 12,
    concurrency: 1.25,
    checkShare: 0.2,
    rounds: { total: 3 },
    costUsd: 9,
  } as NonNullable<RunView["metrics"]>;
  render(
    <RunFlowView
      flow={flow}
      run={{ ...run, metrics }}
      now={Date.parse(at(500))}
      onOpen={vi.fn<(selection: FlowSelection) => void>()}
    />,
  );
  const sheet = screen.getByLabelText("Run statistics");
  expect(sheet).toHaveTextContent("Wall time5m");
  expect(sheet).toHaveTextContent("Idle12%");
  expect(sheet).toHaveTextContent("Concurrency1.25");
  expect(sheet).toHaveTextContent("Check share20%");
  expect(sheet).toHaveTextContent("Review rounds3");
  expect(sheet).toHaveTextContent("$9.00");
  expect(screen.getByRole("button", { name: /C1 check/ })).toHaveAttribute("data-tone", "danger");
  expect(screen.getByText("Timing unknown")).toBeVisible();
  expect(screen.getByRole("button", { name: /C1 check/ }).querySelector("[data-timing-unknown]")).toHaveClass(
    "stroke-danger",
  );
  const labels = within(screen.getByLabelText("Flow rows")).getAllByText(
    /^(Architect|L[1-8]|Unassigned roles|Run checks|Idle)$/,
  );
  expect(labels[0]).toHaveTextContent("Architect");
  expect(labels.at(-1)).toHaveTextContent("Idle");
});

test("role labels, legend and markers use readable theme token pairs", () => {
  render(
    <RunFlowView
      flow={flowFixture()}
      run={run}
      now={Date.parse(at(150))}
      onOpen={vi.fn<(selection: FlowSelection) => void>()}
    />,
  );
  expect(screen.getByRole("button", { name: /C1 check/ }).querySelector("svg text")).toHaveClass("fill-background");
  expect(screen.getByRole("button", { name: /T2 reviewer/ }).querySelector("svg text")).toHaveClass(
    "fill-accent-foreground",
  );
  expect(screen.getByText(/Rung changed/)).toHaveClass("fill-foreground");
  for (const name of ["Worker / writer / artist", "Reviewer / verifier", "Researcher"]) {
    expect(screen.getByText(name)).toHaveClass("text-foreground");
  }
});

test("each idle reason has a distinct fill and keeps its readable text label", () => {
  const flow = flowFixture();
  const reasons = ["owner", "quota", "check", "gap"] as const;
  flow.idle = reasons.map((reason, i) => ({
    startedAt: at(i * 20),
    endedAt: at(i * 20 + 15),
    reason,
    evidenceSeqs: [],
  }));
  const { container } = render(
    <RunFlowView
      flow={flow}
      run={run}
      now={Date.parse(at(150))}
      onOpen={vi.fn<(selection: FlowSelection) => void>()}
    />,
  );
  const fills = {
    owner: "fill-accent/20",
    quota: "fill-warning/20",
    check: "fill-chart-2/20",
    gap: "fill-surface-tertiary",
  };
  const labels = { owner: "Owner", quota: "Quota", check: "Check", gap: "Gap" };
  for (const reason of reasons) {
    const interval = container.querySelector(`[data-idle-reason="${reason}"]`);
    expect(interval).not.toBeNull();
    expect(interval?.querySelector('rect[height="14"]')).toHaveClass(fills[reason]);
    expect(interval?.querySelector("svg text")).toHaveClass("fill-foreground");
    expect(interval).toHaveTextContent(labels[reason]);
  }
});
