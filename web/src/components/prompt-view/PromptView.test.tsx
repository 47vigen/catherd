import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "../../test/dom-shims";
import worker from "./fixtures/worker-brief.md?raw";
import { PromptView } from "./PromptView";

test("a brief reads as its sections, outlined, with tags shown as elements and no literal tag text", () => {
  const { container } = render(<PromptView source={worker} />);
  const nav = screen.getByRole("navigation", { name: "Prompt sections" });
  expect(
    within(nav)
      .getAllByRole("button")
      .map((b) => b.textContent?.replace(/\d[\d,]*$/, "")),
  ).toEqual([
    "<role>Role",
    "<team>Team",
    "<context>Context",
    "<task>Task",
    "<done_when>Done when",
    "<reply_contract>Reply contract",
  ]);
  expect(screen.getByRole("button", { name: /<plan-task\s*file=.*id="1".*Plan task 1/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /<lane-file\s*path="lanes\/M1\.L1\.md".*Lane file/ })).toBeInTheDocument();
  // Placeholders, tools, commands and keywords are marked up, not left as raw text.
  expect(container.querySelector("[data-token]")).toBeNull();
  const codes = [...container.querySelectorAll("code")].map((c) => c.textContent);
  expect(codes).toContain("mcp__plugin_catherd_catherd__read_run_file");
  expect(codes).toContain("catherd run-file read <run> <path>");
  expect(screen.getAllByText("STATUS:").length).toBeGreaterThan(0);
  expect(screen.getAllByText("the conflict").length).toBeGreaterThan(0);
  expect(container.querySelector("p")?.textContent).not.toMatch(/^<role>/);
});

test("Source shows the raw prompt, and Collapse all folds every section", async () => {
  const user = userEvent.setup();
  render(<PromptView source={worker} />);
  await user.click(screen.getByRole("button", { name: "Collapse all" }));
  expect(
    screen.getAllByRole("button", { name: /<role>\s*Role/ }).find((b) => b.hasAttribute("aria-expanded")),
  ).toHaveAttribute("aria-expanded", "false");
  await user.click(screen.getByRole("button", { name: "Source" }));
  expect(document.querySelector("pre")?.textContent).toContain('<plan-task file="2026-10-22-03-case.md" id="1">');
});

test("a prompt without tags is plain markdown, with no outline", () => {
  render(<PromptView source={"Do **this** with <path>."} />);
  expect(screen.queryByRole("navigation")).toBeNull();
  expect(screen.getByText("this").tagName).toBe("STRONG");
  expect(screen.getByText("path")).toBeInTheDocument();
});
