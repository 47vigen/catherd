// Adapted from anomalyco/opencode packages/tui/src/ui/toast.tsx (MIT, © 2025 opencode);
// see THIRD_PARTY_NOTICES.md.
import type { Clock } from "@opentui/core";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ToastVariant = "info" | "success" | "warning" | "error";
export interface Toast {
  variant: ToastVariant;
  message: string;
}

/** How long a toast stays before the next one in the queue shows. */
export const TOAST_MS = 4_000;

interface ToastApi {
  current: Toast | null;
  queued: number;
  show(t: Toast): void;
}

const ToastContext = createContext<ToastApi>({ current: null, queued: 0, show: () => {} });

/** Spec §9.3: toasts queue at the top right; one shows at a time, for TOAST_MS each. */
export function ToastProvider(props: { clock: Clock; children: ReactNode }) {
  const [queue, setQueue] = useState<Toast[]>([]);
  const head = queue[0] ?? null;
  useEffect(() => {
    if (!head) return;
    const h = props.clock.setTimeout(() => setQueue((q) => q.slice(1)), TOAST_MS);
    return () => props.clock.clearTimeout(h);
  }, [head, props.clock]);
  const show = useCallback((t: Toast) => setQueue((q) => [...q, t]), []);
  const api = useMemo(
    () => ({ current: head, queued: Math.max(0, queue.length - 1), show }),
    [head, queue.length, show],
  );
  return <ToastContext.Provider value={api}>{props.children}</ToastContext.Provider>;
}

export const useToasts = (): ToastApi => useContext(ToastContext);
