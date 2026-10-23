import { Alert, Button, Label, SearchField, Switch } from "@heroui/react";
import { use, useCallback, useEffect, useRef, useState } from "react";

import type { TranscriptFrame } from "../../-hooks/useLiveRun";
import { LiveLogContext } from "../../-lib/live-log";
import { getDispatchStream } from "../../../../../client";
import { errorMessage } from "../../../../../lib/api";
import { mergeTranscript, type Card } from "./merge";
import { TranscriptCards } from "./TranscriptCards";

/** Lines per request; a longer log is paged in with "Load more" (or read on at once, while live). */
const PAGE = 500;

type Pages = { cards: Card[]; lines: string[]; ended: boolean; more: boolean; loaded: boolean; error: string | null };
const EMPTY: Pages = { cards: [], lines: [], ended: false, more: false, loaded: false, error: null };

/**
 * One mode (cards or raw lines) of a dispatch's stream, read page by page from line 0. While `live` full pages are
 * read on at once; otherwise `more` says a full page came back and `loadMore` asks for the next. `onFrame` folds in
 * a frame of the run socket's tail: the cards take its items past the line they hold, the raw lines read on over
 * HTTP (a frame's raw lines carry no line numbers to join them by).
 */
function useStreamPages(runId: string, dispatchId: string, raw: boolean, enabled: boolean, live: boolean) {
  // The pages belong to one stream: a different run, dispatch or mode starts again from nothing, with no effect to reset.
  const key = `${runId}/${dispatchId}/${raw}`;
  const [store, setStore] = useState<{ key: string; pages: Pages }>({ key, pages: EMPTY });
  const pages = store.key === key ? store.pages : EMPTY;
  const pull = useRef<() => Promise<void>>(async () => {});
  const frame = useRef<(f: TranscriptFrame) => void>(() => {});
  const at = useRef(0);
  const liveNow = useRef(live);
  useEffect(() => {
    liveNow.current = live;
  }, [live]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let busy = false;
    let again = false;
    at.current = 0;
    const setPages = (update: (p: Pages) => Pages) =>
      setStore((s) => ({ key, pages: update(s.key === key ? s.pages : EMPTY) }));

    const run = async (): Promise<void> => {
      if (stopped) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      const start = at.current;
      const { data, error } = await getDispatchStream({
        path: { id: runId, dispatchId },
        query: { from: start, limit: PAGE, raw: raw ? "1" : "0" },
      });
      busy = false;
      if (stopped) return;
      if (!data) {
        setPages((p) => ({ ...p, loaded: true, error: errorMessage(error) }));
        return;
      }
      const full = data.next - start >= PAGE;
      // A socket frame may have brought some of these lines while the request was out.
      const held = at.current;
      at.current = Math.max(held, data.next);
      setPages((p) => ({
        cards: raw
          ? p.cards
          : mergeTranscript(
              p.cards,
              data.items.filter((i) => i.line >= held),
            ),
        lines: raw ? [...p.lines, ...(data.raw ?? [])] : p.lines,
        ended: data.ended,
        more: full,
        loaded: true,
        error: null,
      }));
      if ((full && liveNow.current) || again) {
        again = false;
        void run();
      }
    };
    pull.current = run;
    frame.current = (f) => {
      if (raw) return void run();
      const held = at.current;
      if (f.next <= held) return;
      at.current = f.next;
      setPages((p) => ({
        ...p,
        cards: mergeTranscript(
          p.cards,
          f.items.filter((i) => i.line >= held),
        ),
      }));
    };
    void run();
    return () => {
      stopped = true;
    };
  }, [runId, dispatchId, raw, enabled, key]);

  // The dispatch just ended: one last read, so lines written after the last frame are not lost.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) void pull.current();
    wasLive.current = live;
  }, [live]);

  const loadMore = useCallback(() => void pull.current(), []);
  const onFrame = useCallback((f: TranscriptFrame) => frame.current(f), []);
  return { ...pages, loadMore, onFrame, at };
}

/**
 * The log of one dispatch: readable cards or the raw lines, searchable, paged. While `live`, once the pages are in
 * hand, the run socket tails the stream from the last line read; leaving the log stops the tail.
 */
export function TranscriptView({ runId, dispatchId, live }: { runId: string; dispatchId: string; live: boolean }) {
  const [query, setQuery] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const cards = useStreamPages(runId, dispatchId, false, true, live);
  // The raw lines load the first time Raw is switched on.
  const [rawWanted, setRawWanted] = useState(false);
  const lines = useStreamPages(runId, dispatchId, true, rawWanted, live);
  const view = showRaw ? lines : cards;

  const liveLog = use(LiveLogContext);
  const caughtUp = cards.loaded && !cards.more && !cards.error;
  const { onFrame: cardsFrame, at } = cards;
  const linesFrame = lines.onFrame;
  useEffect(() => {
    if (!liveLog || !live || !caughtUp) return;
    const off = liveLog.subscribe((f) => {
      if (f.dispatchId !== dispatchId) return;
      cardsFrame(f);
      if (rawWanted) linesFrame(f);
    });
    liveLog.watch(dispatchId, at.current);
    return () => {
      off();
      liveLog.watch(null, 0);
    };
  }, [liveLog, live, caughtUp, dispatchId, rawWanted, cardsFrame, linesFrame, at]);

  return (
    <section aria-label="Log" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchField value={query} onChange={setQuery} aria-label="Search the log" className="w-full sm:w-72">
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder="Search the log" />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
        <Switch
          size="sm"
          isSelected={showRaw}
          onChange={(on) => {
            setShowRaw(on);
            if (on) setRawWanted(true);
          }}
        >
          <Switch.Content className="flex-row items-center gap-2">
            <Label className="text-muted text-[13px]">Raw</Label>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </div>
      {view.error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>The log could not be read</Alert.Title>
            <Alert.Description>{view.error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {view.loaded || view.error ? (
        <TranscriptCards
          cards={cards.cards}
          raw={showRaw ? lines.lines : null}
          showRaw={showRaw}
          query={query}
          live={live && !view.ended}
        />
      ) : (
        <p className="text-muted text-sm">Reading the log…</p>
      )}
      {view.more && !live ? (
        <div>
          <Button size="sm" variant="secondary" onPress={view.loadMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
