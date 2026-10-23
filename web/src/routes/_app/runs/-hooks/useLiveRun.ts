// Derived from maximhq/bifrost ui/hooks/useWebSocket.tsx (Apache-2.0); modified.
import { useEffect, useEffectEvent, useState } from "react";

import type { RunModelPatch, TimelineEntry, TranscriptItem } from "../../../../client";
import {
  WS_CONNECTING,
  WS_OPEN,
  adoptSocket,
  clearReconnectTimer,
  getSocket,
  isReconnectEnabled,
  resetRetryCount,
  scheduleReconnect,
  setActiveConnect,
  setReconnectEnabled,
  setSocket,
  startHeartbeat,
  stopHeartbeat,
  stopWebSocket,
} from "../../../../lib/live-socket";

function liveUrl(runId: string, from: number): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/runs/${encodeURIComponent(runId)}/live?from=${from}`;
}

/** New lines of the dispatch the page watches (Ruling 11); `next` is the line after the last one sent. */
export type TranscriptFrame = {
  kind: "transcript";
  dispatchId: string;
  items: TranscriptItem[];
  raw: string[];
  next: number;
};
type EventFrame = TimelineEntry & { kind?: "event"; patch?: RunModelPatch | null };
type Frame = EventFrame | TranscriptFrame;

// The socket, heartbeat and reconnect bookkeeping live in lib/live-socket so a
// close event that fires after this hook unmounted consults that shared state
// instead of a stale closure. Only the message listener and per-mount React
// state live here.
const listeners = new Set<(frame: Frame) => void>();

// The dispatch whose stream the socket tails. It belongs to the socket, so a reconnect asks for it again from where
// the last frame ended.
let watching: { dispatchId: string; from: number } | null = null;

function sendWatch(): void {
  const ws = getSocket();
  if (ws?.readyState !== WS_OPEN) return; // the next open sends it
  ws.send(JSON.stringify(watching ? { watch: watching.dispatchId, from: watching.from } : { watch: null }));
}

/** Tails one dispatch's stream over the run's socket from line `from`, or stops tailing with `null`. */
function watch(dispatchId: string | null, from: number): void {
  watching = dispatchId === null ? null : { dispatchId, from };
  sendWatch();
}

/**
 * Streams a run's new timeline entries while `enabled`. The session cookie authenticates the socket; each text
 * frame is one TimelineEntry. `after` is the newest seq the page already holds: the socket asks the server to replay
 * from the one after it (and, on a reconnect, from the one after the last frame it got), so nothing written between
 * the page's fetch and the upgrade, or during a gap, is missed. Turning it off, changing the run or leaving the page
 * closes the socket.
 * An event frame's `patch` also goes to `onPatch` (null: the server could not diff, so read the model again); a
 * transcript frame goes to `onTranscript` only. `watch` picks the dispatch whose stream the socket tails.
 */
export function useLiveRun(
  runId: string,
  enabled: boolean,
  onEntry: (e: TimelineEntry) => void,
  after: number,
  o: { onPatch?: (p: RunModelPatch | null) => void; onTranscript?: (f: TranscriptFrame) => void } = {},
): { isConnected: boolean; watch: (dispatchId: string | null, from: number) => void } {
  const [isConnected, setIsConnected] = useState(false);
  const deliver = useEffectEvent((frame: Frame) => {
    if (frame.kind === "transcript") {
      o.onTranscript?.(frame);
      return;
    }
    onEntry(frame);
    if (frame.patch !== undefined) o.onPatch?.(frame.patch);
  });
  const held = useEffectEvent(() => after);

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;
    // Set when this mount adopts a socket created by an earlier mount;
    // removes the open/close listeners that keep this mount's state honest.
    let detachAdopted: (() => void) | null = null;
    let last = 0;
    const listener = (frame: Frame) => {
      if (frame.kind === "transcript") {
        if (watching?.dispatchId !== frame.dispatchId) return; // a stream no longer watched
        watching.from = Math.max(watching.from, frame.next);
      } else last = Math.max(last, frame.seq);
      deliver(frame);
    };
    listeners.add(listener);

    const connect = () => {
      if (!mounted || !isReconnectEnabled()) {
        return;
      }
      const existing = getSocket();
      if (existing && (existing.readyState === WS_OPEN || existing.readyState === WS_CONNECTING)) {
        // Another mount created this socket; its onopen/onclose cannot
        // update this mount's state, so observe the socket directly.
        detachAdopted?.();
        detachAdopted = adoptSocket(existing, {
          onOpen: () => {
            if (mounted) setIsConnected(true);
          },
          onClose: () => {
            if (mounted) setIsConnected(false);
          },
        });
        if (existing.readyState === WS_OPEN) setIsConnected(true);
        return;
      }

      const ws = new WebSocket(liveUrl(runId, Math.max(last, held()) + 1));
      setSocket(ws);

      ws.onopen = () => {
        if (getSocket() !== ws) return;
        if (mounted) setIsConnected(true);
        resetRetryCount(); // Reset retry count on successful connection
        clearReconnectTimer();
        // The heartbeat belongs to the socket, not to this mount.
        startHeartbeat(ws);
        // A new connection tails no stream until it is asked again.
        if (watching) sendWatch();
      };

      ws.onmessage = (event: MessageEvent) => {
        let frame: Frame;
        try {
          frame = JSON.parse(String(event.data)) as Frame;
        } catch {
          return; // Not a frame.
        }
        if (typeof frame !== "object" || frame === null) return;
        const ok =
          frame.kind === "transcript"
            ? typeof frame.dispatchId === "string" && Array.isArray(frame.items) && typeof frame.next === "number"
            : typeof frame.seq === "number" && typeof frame.type === "string";
        if (ok) listeners.forEach((handler) => handler(frame));
      };

      ws.onclose = () => {
        if (mounted) setIsConnected(false);
        if (getSocket() === ws) {
          stopHeartbeat();
          setSocket(null);
        }
        // Reconnect through the currently mounted hook (if any), not
        // through this closure, so an unmounted hook never revives the loop.
        scheduleReconnect();
      };

      ws.onerror = () => {
        if (mounted) setIsConnected(false);
        ws.close();
      };
    };

    // A fresh mount means the page wants live entries: re-arm reconnection
    // that an earlier stop switched off.
    setReconnectEnabled(true);
    setActiveConnect(connect);
    connect();

    return () => {
      mounted = false;
      listeners.delete(listener);
      setActiveConnect(null);
      clearReconnectTimer();
      detachAdopted?.();
      detachAdopted = null;
      // The page was left, or another run opened: close the socket and forget its stream.
      watching = null;
      stopWebSocket();
      setIsConnected(false);
    };
  }, [enabled, runId]);

  return { isConnected, watch };
}
