import { Magnifier } from "@gravity-ui/icons";
import { Header, Kbd, ListBox, Modal, SearchField, useFilter } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, use, useEffect, useState } from "react";
import { Autocomplete } from "react-aria-components";

import { listRunsOptions } from "../../../client/@tanstack/react-query.gen";

type Entry = { id: string; label: string; hint?: string; href: string };

const PAGES: Entry[] = [
  { id: "page:/", label: "Dashboard", href: "/" },
  { id: "page:/runs", label: "Runs", href: "/runs" },
  { id: "page:/questions", label: "Questions", href: "/questions" },
  { id: "page:/models", label: "Models", href: "/models" },
  { id: "page:/setup", label: "Setup", href: "/setup" },
];

const ACTIONS: Entry[] = [{ id: "do:answer", label: "Answer a question", href: "/questions" }];

const LIMIT = 200;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function Section({ title, items }: { title: string; items: Entry[] }) {
  if (items.length === 0) return null;
  return (
    <ListBox.Section>
      <Header className="label-caps text-muted px-2 pt-3 pb-1">{title}</Header>
      {items.map((e) => (
        <ListBox.Item key={e.id} id={e.id} href={e.href} textValue={`${e.label} ${e.hint ?? ""}`}>
          <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <span className="truncate">{e.label}</span>
            {e.hint ? <span className="text-muted truncate font-mono text-xs">{e.hint}</span> : null}
          </span>
        </ListBox.Item>
      ))}
    </ListBox.Section>
  );
}

const OpenContext = createContext<() => void>(() => {});

/** The search field look-alike that opens the menu. */
function Trigger() {
  const open = use(OpenContext);
  return (
    <button
      type="button"
      onClick={open}
      className="border-border bg-surface text-muted hover:text-foreground hover:bg-surface-secondary flex h-8 w-full items-center gap-2 rounded-sm border px-2.5 text-[13px] transition-colors duration-150 max-sm:w-8 max-sm:justify-center max-sm:px-0"
    >
      <Magnifier aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="hidden flex-1 text-left sm:inline">Search</span>
      <Kbd className="hidden h-5 px-1.5 font-mono text-[11px] sm:inline-flex">{isMac ? "⌘K" : "Ctrl K"}</Kbd>
      <span className="sr-only sm:hidden">Search</span>
    </button>
  );
}

/** Jump to any page or run, or start a common task. Opens with ⌘K / Ctrl+K or a Trigger. */
function Root({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false);
  const { contains } = useFilter({ sensitivity: "base" });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const runs = useQuery({ ...listRunsOptions({ query: { limit: LIMIT } }), enabled: isOpen });

  const runItems: Entry[] = (runs.data?.items ?? []).map((r) => ({
    id: `run:${r.id}`,
    label: r.title,
    hint: r.phase ?? "1.5",
    href: `/runs/${encodeURIComponent(r.id)}`,
  }));

  return (
    <OpenContext value={() => setOpen(true)}>
      {children}
      <Modal.Backdrop isOpen={isOpen} onOpenChange={setOpen} isDismissable className="no-motion">
        <Modal.Container placement="top" size="lg" className="pt-[12vh]">
          <Modal.Dialog aria-label="Search" className="overflow-hidden p-0">
            <Autocomplete filter={contains}>
              <div className="border-border border-b p-2">
                {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- a command menu exists to be typed into at once */}
                <SearchField aria-label="Search" autoFocus className="w-full">
                  <SearchField.Group className="border-0 bg-transparent">
                    <SearchField.SearchIcon />
                    <SearchField.Input placeholder="Jump to a page or a run" />
                    <SearchField.ClearButton />
                  </SearchField.Group>
                </SearchField>
              </div>
              <ListBox
                aria-label="Results"
                className="scrollbar max-h-[min(60vh,440px)] overflow-y-auto p-1.5"
                onAction={() => setOpen(false)}
                renderEmptyState={() => <p className="text-muted px-3 py-8 text-center text-sm">Nothing matches.</p>}
              >
                <Section title="Go to" items={PAGES} />
                <Section title="Actions" items={ACTIONS} />
                <Section title="Runs" items={runItems} />
              </ListBox>
            </Autocomplete>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </OpenContext>
  );
}

export const CommandMenu = Object.assign(Root, { Root, Trigger });
