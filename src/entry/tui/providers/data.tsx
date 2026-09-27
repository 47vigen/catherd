import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, isCatherdError } from "../../../domain/errors.ts";
import type { DoctorReport } from "../../../services/doctor.ts";
import type { Effects, RunRow } from "../effects.ts";
import { useApp } from "./app.tsx";

export interface Polled<T> {
  value: T | null;
  error: string | null;
  /** what to do about `error`, when the failure says (a CatherdError's fix) */
  fix: string | null;
  /** clock time of the last good read, null before the first */
  at: number | null;
  refresh(): void;
}

/**
 * Reads `read` now and every `everyMs` while not paused, off the render path (spec §9.4: runs data is
 * polled off the render path): a read runs in a timer callback, never while React renders.
 */
export function usePoll<T>(
  read: () => T,
  everyMs: number,
  o: { paused?: boolean; key?: string } = {},
): Polled<T> {
  const { clock } = useApp();
  const [state, setState] = useState<{
    value: T | null;
    error: string | null;
    fix: string | null;
    at: number | null;
  }>({ value: null, error: null, fix: null, at: null });
  const readRef = useRef(read);
  readRef.current = read;
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const run = () => {
      try {
        setState({ value: readRef.current(), error: null, fix: null, at: clock.now() });
      } catch (e) {
        // `at` stays the time of the last good read: old rows must not read as fresh
        setState((s) => ({
          ...s,
          error: errorMessage(e),
          fix: isCatherdError(e) && e.fix ? e.fix : null,
        }));
      }
    };
    const first = clock.setTimeout(run, 0);
    const every = o.paused ? null : clock.setInterval(run, everyMs);
    return () => {
      clock.clearTimeout(first);
      if (every !== null) clock.clearInterval(every);
    };
  }, [clock, everyMs, o.paused, o.key, nonce]);
  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

/** `read` once, off the render path, and again whenever `key` changes or `refresh` is called. */
export function useLoad<T>(read: () => T, key = ""): Polled<T> {
  return usePoll(read, 0, { paused: true, key });
}

/** How often the run list is read again, unless paused (spec §9.1 Runs: "updated Ns ago"; `p` pauses). */
export const RUNS_EVERY_MS = 2_000;

export interface Data {
  report: DoctorReport | null;
  checking: boolean;
  checkedAt: number | null;
  checkError: string | null;
  recheck(): void;
  runs: Polled<{ rows: RunRow[]; warnings: string[] }>;
  /** the profile names and the active one; read on the runs' cadence and after every profile write */
  profiles: Polled<ReturnType<Effects["profiles"]>>;
}

const DataContext = createContext<Data | null>(null);

export function useData(): Data {
  const d = useContext(DataContext);
  if (!d) throw new Error("useData must be used inside DataProvider");
  return d;
}

/** Spec §9.4 providers: the data every tab and the header share, read off the render path. */
export function DataProvider(props: { children: ReactNode }) {
  const app = useApp();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setChecking(true);
    const h = app.clock.setTimeout(() => {
      app.effects
        .doctor()
        .then((r) => {
          if (!live) return;
          setReport(r);
          setCheckError(null);
        })
        .catch((e: unknown) => live && setCheckError(errorMessage(e)))
        .finally(() => {
          if (!live) return;
          setChecking(false);
          setCheckedAt(app.clock.now());
        });
    }, 0);
    return () => {
      live = false;
      app.clock.clearTimeout(h);
    };
  }, [app.effects, app.clock, nonce]);
  const runs = usePoll(() => app.effects.runs(), RUNS_EVERY_MS, { paused: app.state.paused });
  // cheap (a directory listing and two small reads), and another terminal may change them at any time
  const profiles = usePoll(() => app.effects.profiles(), RUNS_EVERY_MS);
  const value = useMemo(
    () => ({
      report,
      checking,
      checkedAt,
      checkError,
      recheck: () => setNonce((n) => n + 1),
      runs,
      profiles,
    }),
    [report, checking, checkedAt, checkError, runs, profiles],
  );
  return <DataContext.Provider value={value}>{props.children}</DataContext.Provider>;
}
