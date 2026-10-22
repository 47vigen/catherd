import { render, screen } from "@testing-library/react";

import { StatusChip } from "./StatusChip";

test.each([
  ["running", "success", "Running"],
  ["done", "success", "Done"],
  ["alive", "success", "Alive"],
  ["ok", "success", "Ok"],
  ["planning", "warning", "Planning"],
  ["approval", "warning", "Approval"],
  ["parked", "warning", "Parked"],
  ["held", "warning", "Held"],
  ["warn", "warning", "Warn"],
  ["failed", "danger", "Failed"],
  ["dead", "danger", "Dead"],
  ["fail", "danger", "Fail"],
  ["cancelled", "default", "Cancelled"],
  ["skip", "default", "Skip"],
  ["info", "default", "Info"],
  ["pending", "default", "Pending"],
  ["skipped", "default", "Skipped"],
  ["paused", "warning", "Paused"],
] as const)("%s uses HeroUI color %s", (status, color, label) => {
  const { container } = render(<StatusChip status={status} />);
  const chip = container.querySelector('[data-slot="chip"]');
  expect(chip).toHaveAttribute("data-color", color);
  expect(chip).toHaveTextContent(label);
});

test("held shows the time it ends", () => {
  render(<StatusChip status="held" until="2026-10-14T10:30:00Z" />);
  expect(screen.getByText(/until/)).toBeInTheDocument();
  expect(screen.getByText(/until/).closest("time") ?? screen.getByText(/until/)).toBeInTheDocument();
});

test("until is ignored for other states", () => {
  render(<StatusChip status="running" until="2026-10-14T10:30:00Z" />);
  expect(screen.queryByText(/until/)).toBeNull();
});

test("a label replaces the status word and keeps its colour", () => {
  const { container } = render(<StatusChip status="fail" label="missing" />);
  const chip = container.querySelector('[data-slot="chip"]');
  expect(chip).toHaveAttribute("data-color", "danger");
  expect(chip).toHaveTextContent("Missing");
});
