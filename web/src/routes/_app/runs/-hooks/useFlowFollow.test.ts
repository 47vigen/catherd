import { act, fireEvent, renderHook } from "@testing-library/react";

import { at } from "../-lib/flow.fixture";
import { useFlowFollow, useQuotaBoundary } from "./useFlowFollow";

test("initial follow, user opt-out across patches and explicit resume without animation", () => {
  const el = document.createElement("div");
  Object.defineProperties(el, { clientWidth: { value: 200 }, scrollWidth: { value: 2000 } });
  const ref = { current: el };
  const { result, rerender, unmount } = renderHook(({ nowX, live }) => useFlowFollow(ref, live, nowX), {
    initialProps: { nowX: 500, live: true },
  });
  expect(el.scrollLeft).toBe(348);
  fireEvent.wheel(el, { deltaX: -20 });
  rerender({ nowX: 600, live: true });
  expect(el.scrollLeft).toBe(348);
  act(() => result.current.resume());
  expect(el.scrollLeft).toBe(448);
  el.scrollLeft = 400;
  fireEvent.scroll(el);
  rerender({ nowX: 700, live: true });
  expect(el.scrollLeft).toBe(548);
  rerender({ nowX: 800, live: false });
  expect(el.scrollLeft).toBe(548);
  unmount();
});
test("quota deadline refreshes once and cleans up on unmount", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at(0)));
  const refresh = vi.fn<() => void>();
  const holds = [{ startedAt: at(0), endedAt: null, until: at(10), quota: "q", evidenceSeqs: [] }];
  const { rerender, unmount } = renderHook(() => useQuotaBoundary("r1", holds, true, refresh));
  act(() => vi.advanceTimersByTime(10000));
  expect(refresh).toHaveBeenCalledTimes(1);
  rerender();
  act(() => vi.advanceTimersByTime(10000));
  expect(refresh).toHaveBeenCalledTimes(1);
  unmount();
  vi.useRealTimers();
});

test("touch, pointer and keyboard navigation opt out; ending and unmounting remove listeners", () => {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 200 });
  const ref = { current: el };
  const { result, rerender, unmount } = renderHook(({ live }) => useFlowFollow(ref, live, 500), {
    initialProps: { live: true },
  });
  fireEvent.touchStart(el);
  expect(result.current.following).toBe(false);
  act(() => result.current.resume());
  fireEvent.pointerDown(el);
  expect(result.current.following).toBe(false);
  act(() => result.current.resume());
  fireEvent.keyDown(el, { key: "ArrowLeft" });
  expect(result.current.following).toBe(false);
  rerender({ live: false });
  act(() => result.current.resume());
  expect(result.current.following).toBe(false);
  unmount();
});
