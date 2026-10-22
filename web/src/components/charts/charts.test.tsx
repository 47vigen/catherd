import { render, screen } from "@testing-library/react";

import { Bars } from "./Bars";
import { Meter } from "./Meter";
import { StackedBars } from "./StackedBars";

const rows = [
  {
    label: "Mon",
    parts: [
      { key: "a", value: 2 },
      { key: "b", value: 1 },
    ],
  },
  {
    label: "Tue",
    parts: [
      { key: "a", value: 0 },
      { key: "b", value: 0 },
    ],
  },
  {
    label: "Wed",
    parts: [
      { key: "a", value: 4 },
      { key: "b", value: 0 },
    ],
  },
];

test("stacked bars draw a slot per row, an empty one for a zero day", () => {
  const { container } = render(
    <StackedBars
      title="Spend per day"
      meaning="What each day cost."
      rows={rows}
      keys={["a", "b"]}
      format={(n) => `$${n}`}
    />,
  );
  expect(screen.getByRole("img", { name: "Spend per day" }).tagName.toLowerCase()).toBe("svg");
  expect(container.querySelectorAll("[data-slot='row']")).toHaveLength(3);
  expect(container.querySelectorAll("[data-slot='row'][data-empty='true']")).toHaveLength(1);
  expect(screen.getByText("What each day cost.")).toBeInTheDocument();
});

test("each bar names its value", () => {
  const { container } = render(
    <StackedBars title="Spend per day" meaning="m" rows={rows} keys={["a", "b"]} format={(n) => `$${n}`} />,
  );
  const titles = [...container.querySelectorAll("rect > title")].map((t) => t.textContent);
  expect(titles).toContain("Mon, a: $2");
  expect(titles).toContain("Mon, b: $1");
  expect(titles.some((t) => t?.startsWith("Tue"))).toBe(false);

  const bars = render(
    <Bars title="Runs by state" meaning="How runs ended." rows={[{ label: "done", value: 3 }]} format={String} />,
  );
  expect([...bars.container.querySelectorAll("rect > title")].map((t) => t.textContent)).toContain("done: 3");
  expect(screen.getByRole("img", { name: "Runs by state" })).toBeInTheDocument();
});

test("a meter reads as a percentage", () => {
  render(<Meter value={0.42} label="Coding score" />);
  expect(screen.getByRole("meter", { name: "Coding score" })).toHaveAttribute("aria-valuenow", "0.42");
});
