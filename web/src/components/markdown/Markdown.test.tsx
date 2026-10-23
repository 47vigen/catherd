import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "../../test/dom-shims";
import { Markdown } from "./Markdown";

test("raw html in the source stays text", () => {
  const { container } = render(<Markdown source={"Hello <script>alert(1)</script> world\n\n<b>bold?</b>"} />);
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("b")).toBeNull();
  expect(container).toHaveTextContent("<script>alert(1)</script>");
});

test("a table renders as a table", () => {
  const { container } = render(<Markdown source={"| a | b |\n| - | - |\n| 1 | 2 |\n"} />);
  expect(container.querySelector("table")).not.toBeNull();
  expect(screen.getByRole("columnheader", { name: "a" })).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "2" })).toBeInTheDocument();
});

test("headings, lists and inline code render as elements", () => {
  render(<Markdown source={"# Plan\n\n- one\n- two with `code`\n"} />);
  expect(screen.getByRole("heading", { name: "Plan", level: 1 })).toBeInTheDocument();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
});

test("one fact per line stays one per line: a single line break is kept", () => {
  const { container } = render(<Markdown source={"Reviewer: PASS\nVerifier: PASS\n"} />);
  const p = container.querySelector("p")!;
  expect(p.textContent).toBe("Reviewer: PASS\nVerifier: PASS");
  expect(p).toHaveClass("whitespace-pre-line");
});

test("a fenced block renders through CodeBlock", () => {
  const { container } = render(<Markdown source={"```ts\nconst a = 1;\n```\n"} />);
  const pre = container.querySelector("pre");
  expect(pre).not.toBeNull();
  expect(pre).toHaveTextContent("const a = 1;");
  expect(pre?.className).toContain("font-mono");
});

test("a link opens safely in a new tab", () => {
  render(<Markdown source="[docs](https://example.com)" />);
  const link = screen.getByRole("link", { name: "docs" });
  expect(link).toHaveAttribute("href", "https://example.com");
  expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
});

test("the Source toggle shows the raw text", async () => {
  const source = "# Plan\n\n- one\n";
  const { container } = render(<Markdown source={source} />);
  expect(container.querySelector("pre")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Source" }));
  expect(screen.queryByRole("heading", { name: "Plan" })).toBeNull();
  expect(container.querySelector("pre")).toHaveTextContent("# Plan");
  await userEvent.click(screen.getByRole("button", { name: "Rendered" }));
  expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
});

test("copy puts the raw text on the clipboard", async () => {
  const user = userEvent.setup();
  const source = "# Plan\n";
  render(<Markdown source={source} />);
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(await navigator.clipboard.readText()).toBe(source);
});
