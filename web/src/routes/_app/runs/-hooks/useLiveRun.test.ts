import { act, renderHook } from "@testing-library/react";

import type { RunModelPatch, TimelineEntry } from "../../../../client";
import { getSocket, stopWebSocket } from "../../../../lib/live-socket";
import { type TranscriptFrame, useLiveRun } from "./useLiveRun";

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

test("a transcript frame reaches onTranscript, not onEntry", () => {
  const onEntry = vi.fn<(e: TimelineEntry) => void>();
  const onTranscript = vi.fn<(f: TranscriptFrame) => void>();
  const onPatch = vi.fn<(p: RunModelPatch | null) => void>();
  const { result } = renderHook(() => useLiveRun("r1", true, onEntry, 0, { onTranscript, onPatch }));
  const ws = FakeSocket.instances[0]!;
  act(() => ws.open());
  act(() => result.current.watch("d1", 0));
  const frame = { kind: "transcript", dispatchId: "d1", items: [], raw: ["{}"], next: 1 };
  act(() => ws.onmessage?.({ data: JSON.stringify(frame) }));
  // a frame of a stream the page stopped watching is dropped
  act(() => ws.onmessage?.({ data: JSON.stringify({ ...frame, dispatchId: "d0" }) }));
  expect(onTranscript).toHaveBeenCalledExactlyOnceWith(frame);
  expect(onEntry).not.toHaveBeenCalled();
  const patch = { seq: 7, phase: "running", outcome: null, nodes: [], removed: [], edges: null };
  act(() => ws.onmessage?.({ data: JSON.stringify({ ...entry, kind: "event", patch }) }));
  expect(onEntry).toHaveBeenCalledOnce();
  expect(onPatch).toHaveBeenCalledExactlyOnceWith(patch);
});

test("watch sends the message and resends it after a reconnect", () => {
  vi.useFakeTimers();
  try {
    const { result } = renderHook(() => useLiveRun("r1", true, () => {}, 0));
    const first = FakeSocket.instances[0]!;
    // asked before the socket opened: sent on open
    act(() => result.current.watch("d1", 4));
    expect(first.sent).toEqual([]);
    act(() => first.open());
    expect(first.sent).toEqual([JSON.stringify({ watch: "d1", from: 4 })]);
    const frame = { kind: "transcript", dispatchId: "d1", items: [], raw: [], next: 9 };
    act(() => first.onmessage?.({ data: JSON.stringify(frame) }));
    act(() => first.close());
    act(() => vi.advanceTimersByTime(1000));
    const second = FakeSocket.instances[1]!;
    act(() => second.open());
    // the new connection goes on from the last line it got
    expect(second.sent).toEqual([JSON.stringify({ watch: "d1", from: 9 })]);
    act(() => result.current.watch(null, 0));
    expect(second.sent.at(-1)).toBe(JSON.stringify({ watch: null }));
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
