import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";

import type { FlowQuotaHold } from "../../../../client";

export function useFlowFollow(ref: RefObject<HTMLElement | null>, live: boolean, nowX: number) {
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || !live) return;
    const stop = () => setFollowing(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === " " && e.target instanceof Element && e.target.closest('[role="button"]')) return;
      if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", " "].includes(e.key)) stop();
    };
    el.addEventListener("wheel", stop, { passive: true });
    el.addEventListener("touchstart", stop, { passive: true });
    const pointer = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('[role="button"]')) stop();
    };
    el.addEventListener("pointerdown", pointer);
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchstart", stop);
      el.removeEventListener("pointerdown", pointer);
      el.removeEventListener("keydown", key);
    };
  }, [ref, live]);
  useEffect(() => {
    const el = ref.current;
    if (el && live && following) el.scrollLeft = Math.max(0, nowX - el.clientWidth + 48);
  }, [ref, live, following, nowX]);
  return { following: live && following, resume: () => setFollowing(true) };
}

/** Expiry needs reducer evidence again, without polling or a second ticker. */
export function useQuotaBoundary(runId: string, holds: FlowQuotaHold[], live: boolean, refresh: () => void) {
  const fired = useRef(new Set<string>());
  const deliver = useEffectEvent(refresh);
  useEffect(() => {
    if (!live) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const h of holds) {
      const key = `${runId}/${h.quota}/${h.until}`;
      const delay = Date.parse(h.until) - Date.now();
      if (h.endedAt !== null || fired.current.has(key) || delay <= 0) continue;
      const schedule = () => {
        const remaining = Date.parse(h.until) - Date.now();
        if (remaining <= 0) {
          fired.current.add(key);
          deliver();
        } else timers.push(setTimeout(schedule, Math.min(remaining, 2_147_483_647)));
      };
      schedule();
    }
    return () => timers.forEach(clearTimeout);
  }, [runId, holds, live]);
}
