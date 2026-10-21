import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConfirmDelete } from "./ConfirmDelete";

test("asks before deleting and reports the choice", async () => {
  const onConfirm = vi.fn<() => void>();
  const onCancel = vi.fn<() => void>();
  const { rerender } = render(
    <ConfirmDelete
      title="Delete key?"
      body="Clients using it stop working."
      isOpen
      isPending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  expect(screen.getByRole("alertdialog", { name: "Delete key?" })).toHaveTextContent("Clients using it stop working.");
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  rerender(
    <ConfirmDelete
      title="Delete key?"
      body="x"
      isOpen={false}
      isPending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("takes its own button labels", async () => {
  const onConfirm = vi.fn<() => void>();
  const onCancel = vi.fn<() => void>();
  render(
    <ConfirmDelete
      title="Cancel the run?"
      body="x"
      isOpen
      isPending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      confirmLabel="Cancel run"
      cancelLabel="Keep running"
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel run" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Keep running" }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});
