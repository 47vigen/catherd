// Adapted from anomalyco/opencode packages/tui/src/ui/toast.tsx (MIT, © 2025 opencode);
// see THIRD_PARTY_NOTICES.md.
import type { Clock } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { errorMessage, isCatherdError } from "../../../domain/errors.ts";

export type ToastVariant = "info" | "success" | "warning" | "error";
export interface Toast {
  variant: ToastVariant;
  message: string;
  /** the command that fixes it, shown in full on its own lines; the toast stays until the next key */
  fix?: string;
}

/** How long a toast stays before the next one in the queue shows (one with a fix waits for a key). */
export const TOAST_MS = 4_000;

/** An error as a toast: its message, and its fix command when it has one. */
export const errorToast = (e: unknown): Toast => ({
  variant: "error",
  message: errorMessage(e),
  ...(isCatherdError(e) && e.fix ? { fix: e.fix } : {}),
});

interface ToastApi {
  current: Toast | null;
  queued: number;
  show(t: Toast): void;
}

const ToastContext = createContext<ToastApi>({ current: null, queued: 0, show: () => {} });

/**
 * Spec §9.3: toasts queue at the top right; one shows at a time, for TOAST_MS each. A toast with a fix
 * command stays until the next key, so the command the user must act on is not gone before it is read.
 */
export function ToastProvider(props: { clock: Clock; children: ReactNode }) {
  const renderer = useRenderer();
  const [queue, setQueue] = useState<Toast[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const head = queue[0] ?? null;
  useEffect(() => {
    if (!head || head.fix) return;
    const h = props.clock.setTimeout(() => setQueue((q) => q.slice(1)), TOAST_MS);
    return () => props.clock.clearTimeout(h);
  }, [head, props.clock]);
  useEffect(() => {
    // first in line, before the keymap: a toast the same key shows is not the one it dismisses
    const onKey = () => {
      const shown = queueRef.current[0];
      if (shown?.fix) setQueue((q) => (q[0] === shown ? q.slice(1) : q));
    };
    renderer.keyInput.prependListener("keypress", onKey);
    return () => {
      renderer.keyInput.off("keypress", onKey);
    };
  }, [renderer]);
  const show = useCallback((t: Toast) => setQueue((q) => [...q, t]), []);
  const api = useMemo(
    () => ({ current: head, queued: Math.max(0, queue.length - 1), show }),
    [head, queue.length, show],
  );
  return <ToastContext.Provider value={api}>{props.children}</ToastContext.Provider>;
}

export const useToasts = (): ToastApi => useContext(ToastContext);
