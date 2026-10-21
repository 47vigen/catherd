import { render, screen } from "@testing-library/react";

import { Shell } from "./Shell";

test("Shell.Nav marks the current page and lists every section", () => {
  render(<Shell.Nav current="/questions" />);
  for (const name of ["Runs", "Questions", "Setup"]) expect(screen.getByRole("link", { name })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Questions" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "Runs" })).not.toHaveAttribute("aria-current");
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
  expect(screen.getAllByTestId("custom")).toHaveLength(3);
});
