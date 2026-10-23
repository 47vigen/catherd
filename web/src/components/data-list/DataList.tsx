import { Alert, cn, Label, ListBox, Pagination as HeroPagination, SearchField, Select, Skeleton } from "@heroui/react";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { errorFix, errorMessage } from "../../lib/api";
import { PAGE_SIZES, pageCount } from "../../lib/list-search";
import { CodeBlock } from "../code-block/CodeBlock";

const SEARCH_DEBOUNCE_MS = 300;

function Root({ children }: { children: ReactNode }) {
  return <section className="flex flex-col gap-4">{children}</section>;
}

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function Filters({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/**
 * A compact filter: the label sits inside the trigger ("Status · Healthy"), so a row of filters stays one line.
 * "all" is the unfiltered choice and reports undefined.
 */
function Filter<T extends string>({
  label,
  value,
  options,
  onChange,
  allLabel = "All",
}: {
  label: string;
  value: T | undefined;
  options: readonly { id: T; label: string }[];
  onChange(v: T | undefined): void;
  allLabel?: string;
}) {
  const current = options.find((o) => o.id === value);
  return (
    <Select
      aria-label={label}
      className="w-auto"
      value={value ?? "all"}
      onChange={(key) => onChange(options.find((o) => o.id === key)?.id)}
    >
      <Label className="sr-only">{label}</Label>
      <Select.Trigger className={cn("h-8 min-h-8 items-center py-0 text-[13px]", current && "border-ink-faint")}>
        <span className="flex min-w-0 items-center gap-1.5 leading-none">
          <span className="text-muted">{label}</span>
          <span className={cn("max-w-40 truncate", current ? "text-foreground font-medium" : "text-foreground/70")}>
            {current?.label ?? allLabel}
          </span>
        </span>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="min-w-44">
        <ListBox aria-label={label}>
          {[{ id: "all", label: allLabel }, ...options].map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
              {o.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/** A search box that reports the trimmed query once typing pauses, and follows `value` when the URL changes it. */
function Search({ value, onChange, placeholder }: { value: string; onChange(q: string): void; placeholder: string }) {
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  if (value !== synced) {
    setSynced(value);
    setText(value);
  }
  const report = useEffectEvent((q: string) => onChange(q));

  useEffect(() => {
    const q = text.trim();
    if (q === synced) return;
    const t = setTimeout(() => report(q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text, synced]);

  return (
    <SearchField aria-label={placeholder} value={text} onChange={setText} className="w-full sm:w-72">
      <SearchField.Group className="h-8 text-[13px]">
        <SearchField.SearchIcon />
        <SearchField.Input placeholder={placeholder} />
        <SearchField.ClearButton />
      </SearchField.Group>
    </SearchField>
  );
}

function State({
  isLoading,
  error,
  isEmpty,
  emptyText,
  emptyAction,
  children,
}: {
  isLoading: boolean;
  error?: unknown;
  isEmpty: boolean;
  emptyText: string;
  /** What to do about the empty list, such as a create button; shown under the text. */
  emptyAction?: ReactNode;
  children: ReactNode;
}) {
  if (isLoading)
    return (
      <output
        aria-label="Loading"
        className="bg-surface border-border flex flex-col gap-px overflow-hidden rounded-sm border"
      >
        <div className="bg-surface-secondary h-9" />
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex items-center gap-6 px-4 py-3">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 flex-1" />
            <Skeleton className="h-3.5 w-16" />
          </div>
        ))}
      </output>
    );
  if (error)
    return (
      <Alert status="danger" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Could not load this list</Alert.Title>
          <Alert.Description>{errorMessage(error)}</Alert.Description>
          {errorFix(error) ? <CodeBlock lang="text" code={errorFix(error) as string} className="mt-2" /> : null}
        </Alert.Content>
      </Alert>
    );
  if (isEmpty)
    return (
      <div className="border-border flex flex-col items-center gap-3 rounded-sm border border-dashed px-6 py-8 text-center">
        <p className="text-muted text-sm">{emptyText}</p>
        {emptyAction}
      </div>
    );
  return <>{children}</>;
}

type PageSlot = number | "start-gap" | "end-gap";

/** Page numbers to show: all of them when there are few, otherwise the ends and the neighbours of `page`. */
function pageSlots(page: number, count: number): PageSlot[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const from = Math.max(2, Math.min(page - 1, count - 4));
  const to = Math.min(count - 1, Math.max(page + 1, 5));
  const slots: PageSlot[] = [1];
  if (from > 2) slots.push("start-gap");
  for (let n = from; n <= to; n++) slots.push(n);
  if (to < count - 1) slots.push("end-gap");
  slots.push(count);
  return slots;
}

function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange(n: number): void;
  onPageSizeChange(n: number): void;
}) {
  if (total === 0) return null;
  const count = pageCount(total, pageSize);
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {total > PAGE_SIZES[0] ? (
          <Select
            className="w-20"
            value={pageSize}
            onChange={(key) => {
              const n = Number(key);
              if (n !== pageSize) onPageSizeChange(n);
            }}
          >
            <Label className="sr-only">Rows per page</Label>
            <Select.Trigger aria-label="Rows per page" className="h-8 min-h-8 py-0 text-[13px]">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox aria-label="Rows per page">
                {PAGE_SIZES.map((n) => (
                  <ListBox.Item key={n} id={n} textValue={String(n)}>
                    {n}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        ) : null}
        <span className="text-muted font-mono text-xs whitespace-nowrap tabular-nums">
          {first}–{last} of {total}
        </span>
      </div>
      {count > 1 ? (
        <HeroPagination className="w-auto">
          <HeroPagination.Content>
            <HeroPagination.Item>
              <HeroPagination.Previous
                aria-label="Previous"
                isDisabled={page <= 1}
                onPress={() => onPageChange(page - 1)}
              >
                <HeroPagination.PreviousIcon />
              </HeroPagination.Previous>
            </HeroPagination.Item>
            {pageSlots(page, count).map((slot) =>
              typeof slot === "number" ? (
                <HeroPagination.Item key={slot}>
                  <HeroPagination.Link
                    aria-label={`Page ${slot}`}
                    isActive={slot === page}
                    onPress={() => {
                      if (slot !== page) onPageChange(slot);
                    }}
                  >
                    {slot}
                  </HeroPagination.Link>
                </HeroPagination.Item>
              ) : (
                <HeroPagination.Item key={slot}>
                  <HeroPagination.Ellipsis />
                </HeroPagination.Item>
              ),
            )}
            <HeroPagination.Item>
              <HeroPagination.Next aria-label="Next" isDisabled={page >= count} onPress={() => onPageChange(page + 1)}>
                <HeroPagination.NextIcon />
              </HeroPagination.Next>
            </HeroPagination.Item>
          </HeroPagination.Content>
        </HeroPagination>
      ) : null}
    </div>
  );
}

export const DataList = Object.assign(Root, { Root, Toolbar, Search, Filters, Filter, State, Pagination });
