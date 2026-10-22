import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "../../test/dom-shims";
import { GLOSSARY } from "../../lib/glossary";
import { Term } from "./Term";

test("shows the definition on focus", async () => {
  render(
    <p>
      The <Term name="rung" />
    </p>,
  );
  expect(screen.queryByText(GLOSSARY.rung)).toBeNull();
  await userEvent.tab();
  expect(screen.getByText("rung")).toHaveFocus();
  expect(await screen.findByText(GLOSSARY.rung)).toBeInTheDocument();
});

test("children replace the word and the trigger stays focusable", () => {
  render(<Term name="ladder">ladders</Term>);
  expect(screen.getByText("ladders")).toHaveAttribute("tabindex", "0");
});
