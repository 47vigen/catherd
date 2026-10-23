import { Alert, Button, Label, SearchField, Switch } from "@heroui/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getDispatchStream } from "../../../../../client";
import { errorMessage } from "../../../../../lib/api";
import { mergeTranscript, type Card } from "./merge";
import { TranscriptCards } from "./TranscriptCards";

/** Lines per request; a longer log is paged in with "Load more" (or followed, while live). */
const PAGE = 500;
/** How often a live log asks for lines it has not seen. */
const POLL_MS = 1500;

type Pages = { cards: Card[]; lines: string[]; ended: boolean; more: boolean; loaded: boolean; error: string | null };
const EMPTY: Pages = { cards: [], lines: [], ended: false, more: false, loaded: false, error: null };

/**
 * One mode (cards or raw lines) of a dispatch's stream, read page by page from line 0. While `live` it follows the
 * tail until the dispatch ends; otherwise `more` says a full page came back and `loadMore` asks for the next.
 * shortcut: polls the page endpoint (the run socket's per-dispatch watch needs the shared socket), upgrade when
 * the run page forwards transcript frames.
 */
function useStreamPages(runId: string, dispatchId: string, raw: boolean, enabled: boolean, live: boolean) {
  // The pages belong to one stream: a different run, dispatch or mode starts again from nothing, with no effect to reset.
  const key = `${runId}/${dispatchId}/${raw}`;
  const [store, setStore] = useState<{ key: string; pages: Pages }>({ key, pages: EMPTY });
  const pages = store.key === key ? store.pages : EMPTY;
  const pull = useRef<() => Promise<void>>(async () => {});
  const liveNow = useRef(live);
  useEffect(() => {
    liveNow.current = live;
  }, [live]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let from = 0;
    let busy = false;
    const setPages = (update: (p: Pages) => Pages) =>
      setStore((s) => ({ key, pages: update(s.key === key ? s.pages : EMPTY) }));

    const run = async (): Promise<void> => {
      if (busy || stopped) return;
      busy = true;
      const { data, error } = await getDispatchStream({
        path: { id: runId, dispatchId },
        query: { from, limit: PAGE, raw: raw ? "1" : "0" },
      });
      busy = false;
      if (stopped) return;
      if (!data) {
        setPages((p) => ({ ...p, loaded: true, error: errorMessage(error) }));
        return;
      }
      const full = data.next - from >= PAGE;
      from = data.next;
      setPages((p) => ({
        cards: raw ? p.cards : mergeTranscript(p.cards, data.items),
        lines: raw ? [...p.lines, ...(data.raw ?? [])] : p.lines,
        ended: data.ended,
        more: full,
        loaded: true,
        error: null,
      }));
      // A live log follows the tail (at once while pages come back full); a finished one waits for "Load more".
      if (liveNow.current && !(data.ended && !full)) timer = setTimeout(() => void run(), full ? 0 : POLL_MS);
    };
    pull.current = run;
    void run();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, dispatchId, raw, enabled, key]);

  // The run just stopped being live: one last read so lines written after the final poll are not lost.
  useEffect(() => {
    if (!live) void pull.current();
  }, [live]);

  const loadMore = useCallback(() => void pull.current(), []);
  return { ...pages, loadMore };
}

/** The log of one dispatch: readable cards or the raw lines, searchable, paged, and followed while `live`. */
export function TranscriptView({ runId, dispatchId, live }: { runId: string; dispatchId: string; live: boolean }) {
  const [query, setQuery] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const cards = useStreamPages(runId, dispatchId, false, true, live);
  // The raw lines load the first time Raw is switched on.
  const [rawWanted, setRawWanted] = useState(false);
  const lines = useStreamPages(runId, dispatchId, true, rawWanted, live);
  const view = showRaw ? lines : cards;

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
