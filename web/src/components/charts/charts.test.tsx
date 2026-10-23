import { render, screen } from "@testing-library/react";

import { Blocks } from "./Blocks";
import { ChartTooltip } from "./ChartTooltip";
import { Meter } from "./Meter";
import { Sparkline } from "./Sparkline";

test("a sparkline needs two points and stays decorative", () => {
  const { container, rerender } = render(<Sparkline values={[3]} />);
  expect(container.querySelector("svg")).toBeNull();
  rerender(<Sparkline values={[0, 0, 0]} />);
  const svg = container.querySelector("svg")!;
  expect(svg).toHaveAttribute("aria-hidden", "true");
  // A flat zero series lies on the floor rather than dividing by zero.
  expect(svg.querySelectorAll("polyline")[1]!.getAttribute("points")).toBe("0.00,28.00 50.00,28.00 100.00,28.00");
});

test("blocks light up in proportion, at least one for any share", () => {
  const { container, rerender } = render(<Blocks value={12} max={24} />);
  const lit = () => container.querySelector("[data-lit]")!.getAttribute("data-lit");
  expect(lit()).toBe("12");
  rerender(<Blocks value={0.01} max={1000} />);
  expect(lit()).toBe("1");
  rerender(<Blocks value={0} max={0} />);
  expect(lit()).toBe("0");
});

test("a tooltip lists its rows and sets the total apart", () => {
  render(
    <ChartTooltip title="Thu, Oct 23">
      <ChartTooltip.Row swatch="bg-chart-1" label="Codex" value="$2.00" />
      <ChartTooltip.Row label="Total" value="$2.00" />
    </ChartTooltip>,
  );
  expect(screen.getByText("Thu, Oct 23")).toBeInTheDocument();
  expect(screen.getByText("Codex")).toBeInTheDocument();
  expect(screen.getByText("Total")).toHaveClass("font-medium");
});

test("a meter reads as a percentage", () => {
  render(<Meter value={0.42} label="Coding score" />);
  expect(screen.getByRole("meter", { name: "Coding score" })).toHaveAttribute("aria-valuenow", "0.42");
});
