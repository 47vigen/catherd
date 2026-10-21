import { act, renderHook } from "@testing-library/react";

import type { TimelineEntry } from "../../../../client";
import { getSocket, stopWebSocket } from "../../../../lib/live-socket";
import { useLiveRun } from "./useLiveRun";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  stopWebSocket();
  vi.unstubAllGlobals();
});

const entry = { seq: 7, at: "2026-10-21T10:00:00Z", type: "report.posted", text: "M1 landed" };

test("connects to the run's socket on this host, passes frames and reports the state", () => {
  const onEntry = vi.fn<(e: TimelineEntry) => void>();
  const { result, unmount } = renderHook(() => useLiveRun("r 1", true, onEntry, 4));
  const ws = FakeSocket.instances[0]!;
  expect(ws.url).toBe(`ws://${location.host}/api/runs/r%201/live?from=5`);
  expect(result.current.isConnected).toBe(false);
  act(() => ws.open());
  expect(result.current.isConnected).toBe(true);
  act(() => ws.onmessage?.({ data: JSON.stringify(entry) }));
  expect(onEntry).toHaveBeenCalledWith(entry);
  act(() => ws.onmessage?.({ data: "not json" }));
  act(() => ws.onmessage?.({ data: JSON.stringify({ seq: "7", type: "x" }) }));
  act(() => ws.onmessage?.({ data: JSON.stringify({ seq: 8 }) }));
  expect(onEntry).toHaveBeenCalledTimes(1);
  unmount();
  expect(ws.readyState).toBe(3);
  expect(getSocket()).toBeNull();
});

test("nothing connects while disabled, and turning it off closes the socket", () => {
  const { rerender } = renderHook(({ on }) => useLiveRun("r1", on, () => {}, 0), { initialProps: { on: false } });
  expect(FakeSocket.instances).toHaveLength(0);
  rerender({ on: true });
  expect(FakeSocket.instances).toHaveLength(1);
  rerender({ on: false });
  expect(FakeSocket.instances[0]!.readyState).toBe(3);
});

test("a dropped connection reconnects with backoff", () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => useLiveRun("r1", true, () => {}, 4));
    const first = FakeSocket.instances[0]!;
    act(() => first.open());
    act(() => first.onmessage?.({ data: JSON.stringify({ ...entry, seq: 9 }) }));
    act(() => first.close());
    expect(result.current.isConnected).toBe(false);
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeSocket.instances).toHaveLength(2);
    // the gap is replayed by the server: the reconnect asks from the last frame it got
    expect(FakeSocket.instances[1]!.url).toMatch(/\/live\?from=10$/);
  } finally {
    vi.useRealTimers();
  }
});

test("another run opens its own socket", () => {
  const { rerender } = renderHook(({ id }) => useLiveRun(id, true, () => {}, 0), { initialProps: { id: "a" } });
  rerender({ id: "b" });
  expect(FakeSocket.instances.map((s) => s.url.split("/").at(-2))).toEqual(["a", "b"]);
  expect(FakeSocket.instances[0]!.readyState).toBe(3);
});
