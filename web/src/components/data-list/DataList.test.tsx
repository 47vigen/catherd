import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataList } from "./DataList";

afterEach(() => {
  vi.useRealTimers();
});

test("Search debounces and reports the trimmed query once", async () => {
  // shouldAdvanceTime keeps user-event from stalling on the fake clock; typing takes far less than 300 ms.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const onChange = vi.fn<(q: string) => void>();
  render(<DataList.Search value="" onChange={onChange} placeholder="Search keys" />);
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  await user.type(screen.getByRole("searchbox", { name: "Search keys" }), " fa");
  expect(onChange).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(300);
  });
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith("fa");
});

test("Search follows the value from the URL", () => {
  const onChange = vi.fn<(q: string) => void>();
  const { rerender } = render(<DataList.Search value="a" onChange={onChange} placeholder="Search keys" />);
  expect(screen.getByRole("searchbox", { name: "Search keys" })).toHaveValue("a");
  rerender(<DataList.Search value="b" onChange={onChange} placeholder="Search keys" />);
  expect(screen.getByRole("searchbox", { name: "Search keys" })).toHaveValue("b");
  expect(onChange).not.toHaveBeenCalled();
});

test("State shows the loading, error, empty and content states", () => {
  const { rerender } = render(
    <DataList.State isLoading isEmpty={false} emptyText="No keys yet.">
      <p>rows</p>
    </DataList.State>,
  );
  expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  expect(screen.queryByText("rows")).toBeNull();

  rerender(
    <DataList.State isLoading={false} error={{ error: { message: "nope" } }} isEmpty={false} emptyText="No keys yet.">
      <p>rows</p>
    </DataList.State>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("nope");

  rerender(
    <DataList.State isLoading={false} isEmpty emptyText="No keys yet.">
      <p>rows</p>
    </DataList.State>,
  );
  expect(screen.getByText("No keys yet.")).toBeInTheDocument();
  expect(screen.queryByText("rows")).toBeNull();

  rerender(
    <DataList.State isLoading={false} isEmpty={false} emptyText="No keys yet.">
      <p>rows</p>
    </DataList.State>,
  );
  expect(screen.getByText("rows")).toBeInTheDocument();
});

test("Pagination reports page and page-size changes", async () => {
  const onPageChange = vi.fn<(n: number) => void>();
  const onPageSizeChange = vi.fn<(n: number) => void>();
  render(
    <DataList.Pagination
      page={1}
      pageSize={25}
      total={120}
      onPageChange={onPageChange}
      onPageSizeChange={onPageSizeChange}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "pagination" });
  expect(within(nav).getByRole("button", { name: "Page 5" })).toBeInTheDocument();
  expect(within(nav).getByRole("button", { name: "Previous" })).toBeDisabled();
  expect(within(nav).getByRole("button", { name: "Page 1" })).toHaveAttribute("aria-current", "page");
  await userEvent.click(within(nav).getByRole("button", { name: "Next" }));
  expect(onPageChange).toHaveBeenCalledWith(2);
  await userEvent.click(within(nav).getByRole("button", { name: "Page 4" }));
  expect(onPageChange).toHaveBeenLastCalledWith(4);

  await userEvent.click(screen.getByRole("button", { name: /Rows per page/ }));
  await userEvent.click(await screen.findByRole("option", { name: "50" }));
  expect(onPageSizeChange).toHaveBeenCalledWith(50);
});

test("Pagination elides distant pages", () => {
  render(
    <DataList.Pagination page={10} pageSize={25} total={500} onPageChange={() => {}} onPageSizeChange={() => {}} />,
  );
  const nav = screen.getByRole("navigation", { name: "pagination" });
  for (const n of [1, 9, 10, 11, 20])
    expect(within(nav).getByRole("button", { name: `Page ${n}` })).toBeInTheDocument();
  expect(within(nav).queryByRole("button", { name: "Page 5" })).toBeNull();
  expect(within(nav).getByRole("button", { name: "Next" })).toBeEnabled();
});

test("Pagination steps back to the last page that has rows", () => {
  const onPageChange = vi.fn<(n: number) => void>();
  render(
    <DataList.Pagination page={2} pageSize={25} total={25} onPageChange={onPageChange} onPageSizeChange={() => {}} />,
  );
  expect(onPageChange).toHaveBeenCalledExactlyOnceWith(1);
});
