import { fireEvent, render, screen, within } from "@testing-library/react";

import { at, flowFixture } from "../../-lib/flow.fixture";
import type { FlowSelection, RunView } from "../../../../../client";
import { RunFlowView } from "./RunFlowView";

const run = { id: "r1", phase: "ended", outcome: "done", metrics: null } as RunView;
test("ledger order, dependencies, role markers and overlapping keyboard targets", () => {
  const onOpen = vi.fn<(selection: FlowSelection) => void>();
  render(<RunFlowView flow={flowFixture()} run={run} now={Date.parse(at(150))} onOpen={onOpen} />);
  expect(screen.getByRole("region", { name: "Run flow" })).toBeVisible();
  expect(
    within(screen.getByLabelText("Flow rows"))
      .getAllByText(/^L[1-8]$/)
      .map((n) => n.textContent),
  ).toEqual(["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"]);
  expect(screen.getByTitle(/L8 · Task goal 8/)).toBeVisible();
  const rowLines = screen.getByLabelText("Flow rows").querySelectorAll("foreignObject");
  expect([...rowLines].map((row) => row.getAttribute("height"))).toEqual(Array(rowLines.length).fill("30"));
  expect(screen.getByText("Unassigned roles")).toBeVisible();
  expect(screen.getByText("Run checks")).toBeVisible();
  const bars = within(screen.getByRole("region", { name: "Flow timeline" })).getAllByRole("button");
  expect(bars[0]).toHaveAccessibleName(/architect-1/);
  const cancelled = screen.getByRole("button", { name: /T2 reviewer/ });
  expect(cancelled).toHaveAttribute("data-tone", "danger");
  const limit = screen.getByRole("button", { name: /T3 worker/ });
  expect(limit).toHaveAttribute("data-tone", "warning");
  expect(limit).toHaveAccessibleName(/Limit/);
  expect(limit).not.toHaveTextContent("↗");
  expect(cancelled).toHaveTextContent("↗");
  expect(cancelled).toHaveAccessibleName(/Rung changed/);
  fireEvent.keyDown(cancelled, { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith({ nodeId: "task/T2", attemptId: "D2" });
  fireEvent.focus(cancelled);
  expect(screen.getByRole("tooltip")).toHaveTextContent(/reviewer.*codex:model#high.*cancelled.*20s/);
  expect(screen.getByRole("button", { name: /C1/ })).toHaveAttribute("data-tone", "danger");
  expect(document.querySelector('[data-idle-reason="gap"]')).not.toBeNull();
});
test("a check whose failures are all inherited is not drawn as failed", () => {
  const base = flowFixture();
  const flow = { ...base, checks: base.checks.map((c) => ({ ...c, verdict: "inherited" as const, newFailures: 0 })) };
  render(<RunFlowView flow={flow} run={run} now={Date.parse(at(150))} onOpen={vi.fn<(s: FlowSelection) => void>()} />);
  expect(screen.getByRole("button", { name: /C1 check/ })).not.toHaveAttribute("data-tone", "danger");
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
  flow.checks[0] = { ...flow.checks[0]!, startedAt: null, verdict: "new", exit: null };
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
  expect(
    screen.getByRole("button", { name: /C1 check/ }).querySelector("[data-timing-unknown] title"),
  ).toHaveTextContent("Timing unknown");
  expect(screen.getByRole("button", { name: /C1 check/ }).querySelector("[data-timing-unknown]")).toHaveClass(
    "stroke-danger",
  );
  const labels = within(screen.getByLabelText("Flow rows")).getAllByText(
    /^(Architect|L[1-8]|Unassigned roles|Run checks|Idle)$/,
  );
  expect(labels[0]).toHaveTextContent("Architect");
  expect(labels.at(-1)).toHaveTextContent("Idle");
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
    owner: "fill-accent",
    quota: "fill-warning",
    check: "fill-chart-2",
    gap: "fill-muted",
  };
  const labels = { owner: "Owner", quota: "Quota", check: "Check", gap: "Gap" };
  for (const reason of reasons) {
    const interval = container.querySelector(`[data-idle-reason="${reason}"]`);
    expect(interval).not.toBeNull();
    expect(interval?.querySelector('rect[height="36"]')).toHaveClass(fills[reason]);
    fireEvent.mouseEnter(interval!);
    expect(screen.getByRole("tooltip")).toHaveTextContent(`${labels[reason]} · 0.3 min`);
  }
});

test("zoom stays anchored and Fit resumes live fitting", () => {
  const flow = { ...flowFixture(), endedAt: null };
  const { rerender } = render(
    <RunFlowView
      flow={flow}
      run={{ ...run, phase: "running" }}
      now={Date.parse(at(130))}
      onOpen={vi.fn<(selection: FlowSelection) => void>()}
    />,
  );
  const timeline = screen.getByRole("region", { name: "Flow timeline" });
  Object.defineProperty(timeline, "clientWidth", { value: 600 });
  const svg = timeline.querySelector("svg")!;
  expect(Number(svg.getAttribute("width"))).toBe(600);
  fireEvent.wheel(timeline, { ctrlKey: true, deltaY: -Math.log(2) / 0.01, clientX: 200 });
  expect(Number(svg.getAttribute("width"))).toBeCloseTo(1168);
  expect(timeline.scrollLeft).toBeCloseTo(184);
  rerender(
    <RunFlowView
      flow={flow}
      run={{ ...run, phase: "running" }}
      now={Date.parse(at(140))}
      onOpen={vi.fn<(selection: FlowSelection) => void>()}
    />,
  );
  expect(Number(svg.getAttribute("width"))).toBeGreaterThan(1168);
  fireEvent.click(screen.getByRole("button", { name: "Fit" }));
  expect(Number(svg.getAttribute("width"))).toBe(600);
  rerender(
    <RunFlowView
      flow={flow}
      run={{ ...run, phase: "running" }}
      now={Date.parse(at(150))}
      onOpen={vi.fn<(selection: FlowSelection) => void>()}
    />,
  );
  expect(Number(svg.getAttribute("width"))).toBe(600);
});

test("pointer pinch preserves the stationary finger across moves and drag pans", () => {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  try {
    render(
      <RunFlowView
        flow={flowFixture()}
        run={run}
        now={Date.parse(at(150))}
        onOpen={vi.fn<(selection: FlowSelection) => void>()}
      />,
    );
    const timeline = screen.getByRole("region", { name: "Flow timeline" });
    Object.defineProperty(timeline, "clientWidth", { value: 600 });
    timeline.setPointerCapture = vi.fn<(id: number) => void>();
    const svg = timeline.querySelector("svg")!;
    fireEvent.pointerDown(timeline, { pointerId: 1, pointerType: "touch", clientX: 100 });
    fireEvent.pointerDown(timeline, { pointerId: 2, pointerType: "touch", clientX: 200 });
    const initialWidth = Number(svg.getAttribute("width"));
    const stationaryTime = (100 - 16) / (initialWidth - 32);
    for (let x = 210; x <= 300; x += 10) {
      fireEvent.pointerMove(timeline, { pointerId: 2, pointerType: "touch", clientX: x });
      const stationaryX = 16 + stationaryTime * (Number(svg.getAttribute("width")) - 32) - timeline.scrollLeft;
      expect(stationaryX).toBeCloseTo(100);
    }
    expect(Number(svg.getAttribute("width"))).toBeCloseTo(1168);
    expect(timeline.scrollLeft).toBeCloseTo(84);
    fireEvent.pointerUp(timeline, { pointerId: 1, pointerType: "touch", clientX: 100 });
    fireEvent.pointerUp(timeline, { pointerId: 2, pointerType: "touch", clientX: 300 });
    fireEvent.pointerDown(timeline, { pointerId: 3, pointerType: "mouse", clientX: 300 });
    fireEvent.pointerMove(timeline, { pointerId: 3, pointerType: "mouse", clientX: 250 });
    expect(timeline.scrollLeft).toBeCloseTo(134);
    fireEvent.pointerUp(timeline, { pointerId: 3, pointerType: "mouse", clientX: 250 });
    const pannedTime = (timeline.scrollLeft + 100 - 16) / (Number(svg.getAttribute("width")) - 32);
    fireEvent.pointerDown(timeline, { pointerId: 4, pointerType: "touch", clientX: 100 });
    fireEvent.pointerDown(timeline, { pointerId: 5, pointerType: "touch", clientX: 200 });
    for (let x = 210; x <= 300; x += 10) {
      fireEvent.pointerMove(timeline, { pointerId: 5, pointerType: "touch", clientX: x });
      expect(16 + pannedTime * (Number(svg.getAttribute("width")) - 32) - timeline.scrollLeft).toBeCloseTo(100);
    }
    // Translate both fingers with unchanged separation: this is a pan even when scale does not change.
    const width = Number(svg.getAttribute("width"));
    const scroll = timeline.scrollLeft;
    fireEvent.pointerMove(timeline, { pointerId: 4, pointerType: "touch", clientX: 120 });
    fireEvent.pointerMove(timeline, { pointerId: 5, pointerType: "touch", clientX: 320 });
    expect(Number(svg.getAttribute("width"))).toBe(width);
    expect(timeline.scrollLeft).toBeCloseTo(scroll - 20);
    fireEvent.pointerCancel(timeline, { pointerId: 4 });
    fireEvent.pointerCancel(timeline, { pointerId: 5 });
    fireEvent.pointerMove(timeline, { pointerId: 5, clientX: 350 });
    expect(timeline.scrollLeft).toBeCloseTo(scroll - 20);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("endpoint labels face inward and live Now has its own axis space", () => {
  const flow = flowFixture();
  const { rerender } = render(
    <RunFlowView
      flow={flow}
      run={run}
      now={Date.parse(at(150))}
      onOpen={vi.fn<(selection: FlowSelection) => void>()}
    />,
  );
  const timeline = screen.getByRole("region", { name: "Flow timeline" });
  const ticks = () => [...timeline.querySelectorAll(":scope > svg > g > text")];
  expect(ticks().at(-1)).toHaveAttribute("text-anchor", "end");
  rerender(
    <RunFlowView
      flow={{ ...flow, endedAt: null }}
      run={{ ...run, phase: "running" }}
      now={Date.parse(at(150))}
      onOpen={vi.fn<(selection: FlowSelection) => void>()}
    />,
  );
  const now = within(timeline).getByText("Now");
  expect(now).toHaveAttribute("text-anchor", "end");
  const nowX = Number(now.getAttribute("x"));
  for (const tick of ticks().filter((tick) => tick !== now))
    expect(Number(tick.getAttribute("x")) + (tick.textContent?.length ?? 0) * 7 + 8).toBeLessThanOrEqual(nowX - 24);
});
