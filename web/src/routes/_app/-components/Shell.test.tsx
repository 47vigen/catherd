import { render, screen } from "@testing-library/react";

import { Shell } from "./Shell";

test("the nav lists Dashboard, Runs, Questions and Setup, and marks the current page", () => {
  render(<Shell.Nav current="/questions" />);
  for (const name of ["Dashboard", "Runs", "Questions", "Setup"]) {
    expect(screen.getByRole("link", { name })).toBeInTheDocument();
  }
  expect(screen.getByRole("link", { name: "Questions" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "Runs" })).not.toHaveAttribute("aria-current");
  expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/");
});

test("Dashboard is current on the home page only", () => {
  const { rerender } = render(<Shell.Nav current="/" />);
  expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
  rerender(<Shell.Nav current="/runs" />);
  expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
});

test("Shell.Nav marks a parent section on a nested page", () => {
  render(<Shell.Nav current="/runs/abc" />);
  expect(screen.getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
});

test("Shell.Nav renders links through the given link component", () => {
  render(
    <Shell.Nav
      current="/"
      renderLink={({ href, children, ...rest }) => (
        <a {...rest} href={href} data-testid="custom">
          {children}
        </a>
      )}
    />,
  );
  expect(screen.getAllByTestId("custom")).toHaveLength(4);
});
