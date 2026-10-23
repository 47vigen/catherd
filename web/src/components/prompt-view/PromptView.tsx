import { Button, cn, Disclosure, Meter } from "@heroui/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeBlock } from "../code-block/CodeBlock";
import { COMPONENTS } from "../markdown/Markdown";
import { parsePrompt, type PromptNode, type PromptTag, wordCount } from "./parse";
import { remarkPrompt } from "./remarkPrompt";
import { splitPlaceholders } from "./tokens";

const TITLES: Record<string, string> = {
  role: "Role",
  team: "Team",
  context: "Context",
  task: "Task",
  done_when: "Done when",
  reply_contract: "Reply contract",
  "lane-file": "Lane file",
};

const titleOf = (tag: PromptTag): string =>
  tag.name === "plan-task"
    ? `Plan task${tag.attrs.id ? ` ${tag.attrs.id}` : ""}`
    : (TITLES[tag.name] ?? tag.name.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase()));

const sectionId = (i: number) => `prompt-section-${i}`;

/** `<run>` inside code or prose: a hole to fill, shown as a soft chip with faint brackets. */
const Hole = ({ value }: { value: string }) => (
  <span className="bg-accent/10 text-link rounded-sm px-1 font-mono text-[0.85em] whitespace-nowrap italic">
    <span className="text-muted not-italic">‹</span>
    {value.slice(1, -1)}
    <span className="text-muted not-italic">›</span>
  </span>
);

const codeText = (children: ReactNode) => (typeof children === "string" ? children : String(children ?? ""));

const CODE = "bg-surface-tertiary rounded-sm px-1 py-px font-mono text-[0.85em] break-words";

const PROSE: Components = {
  ...COMPONENTS,
  // A plan task's "- [ ]" steps: a quiet box, not the browser's bright default.
  input: ({ checked, type }) =>
    type === "checkbox" ? (
      <input
        type="checkbox"
        checked={checked}
        disabled
        readOnly
        className="border-border checked:bg-accent me-1.5 inline-block size-3 appearance-none rounded-[2px] border align-[-1px]"
      />
    ) : null,
  li: ({ className, children }) => (
    <li
      className={cn("ps-1 [&>ol]:my-1.5 [&>p]:my-1 [&>ul]:my-1.5", className === "task-list-item" && "-ms-4 list-none")}
    >
      {children}
    </li>
  ),
  code: ({ children, className, ...rest }) => {
    const kind = (rest as { "data-token"?: string })["data-token"];
    const text = codeText(children);
    if (className) return <code className={className}>{children}</code>;
    if (kind === "placeholder") return <Hole value={text} />;
    if (kind === "keyword")
      return (
        <span className="bg-warning/15 text-foreground rounded-sm px-1 py-px font-mono text-[0.8em] font-semibold tracking-wide">
          {text}
        </span>
      );
    return (
      <code className={cn(CODE, kind === "tool" && "code-keyword")}>
        {splitPlaceholders(text).map((p, i) =>
          p.hole ? (
            <span key={i} className="text-link italic">
              {p.value}
            </span>
          ) : (
            p.value
          ),
        )}
      </code>
    );
  },
};

const PLUGINS = [remarkGfm, remarkPrompt];

function Prose({ text }: { text: string }) {
  return (
    <div dir="auto" className="text-foreground min-w-0 text-sm leading-6 break-words">
      <ReactMarkdown remarkPlugins={PLUGINS} components={PROSE}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** A tag as a code editor shows it: coloured brackets and name, attributes as key="value" chips. */
function TagMark({ tag, closing = false }: { tag: PromptTag; closing?: boolean }) {
  const attrs = closing ? [] : Object.entries(tag.attrs);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 font-mono text-xs leading-5">
      <span className="code-punctuation">
        {closing ? "</" : "<"}
        <span className="code-keyword font-medium">{tag.name}</span>
        {attrs.length ? null : ">"}
      </span>
      {attrs.map(([k, v], i) => (
        <span key={k} className="inline-flex max-w-full min-w-0 items-center">
          <span className="bg-surface-tertiary inline-flex min-w-0 rounded-sm px-1.5">
            <span className="code-function">{k}</span>
            <span className="code-punctuation">=</span>
            <span className="code-string truncate">"{v}"</span>
          </span>
          {i === attrs.length - 1 ? <span className="code-punctuation ms-0.5">&gt;</span> : null}
        </span>
      ))}
    </span>
  );
}

function Nodes({ nodes, depth }: { nodes: PromptNode[]; depth: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {nodes.map((n, i) =>
        n.kind === "text" ? <Prose key={i} text={n.text} /> : <Nested key={i} tag={n} depth={depth + 1} />,
      )}
    </div>
  );
}

function Body({ tag, depth }: { tag: PromptTag; depth: number }) {
  return (
    <Disclosure.Content>
      <div className="border-separator flex flex-col gap-3 border-t px-3 py-3 sm:px-4">
        <Nodes nodes={tag.children} depth={depth} />
        {tag.unclosed ? (
          <p className="text-muted font-mono text-xs">This tag is never closed: the prompt ends inside it.</p>
        ) : (
          <TagMark tag={tag} closing />
        )}
      </div>
    </Disclosure.Content>
  );
}

function Header({ tag, words }: { tag: PromptTag; words?: number }) {
  return (
    <Disclosure.Heading>
      <Disclosure.Trigger className="hover:bg-default/60 flex min-h-11 w-full cursor-pointer items-center gap-3 px-3 py-2 text-start sm:px-4">
        <Disclosure.Indicator className="text-muted size-3.5 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <TagMark tag={tag} />
          <span className="text-foreground text-[13px] font-medium">{titleOf(tag)}</span>
        </span>
        {words === undefined ? null : (
          <span className="text-muted shrink-0 font-mono text-xs tabular-nums">{words.toLocaleString()} words</span>
        )}
      </Disclosure.Trigger>
    </Disclosure.Heading>
  );
}

/** A tag inside a section (a plan task, a lane file): an inset card that folds on its own. */
function Nested({ tag, depth }: { tag: PromptTag; depth: number }) {
  const [open, setOpen] = useState(true);
  return (
    <Disclosure
      isExpanded={open}
      onExpandedChange={setOpen}
      className={cn("border-border min-w-0 rounded-sm border", depth % 2 ? "bg-surface-secondary" : "bg-surface")}
    >
      <Header tag={tag} />
      <Body tag={tag} depth={depth} />
    </Disclosure>
  );
}

/** A prompt (a role's brief) read as the document it is: its sections, outlined, foldable, with the source a toggle away. */
export function PromptView({ source }: { source: string }) {
  const nodes = useMemo(() => parsePrompt(source), [source]);
  const sections = useMemo(
    () => nodes.flatMap((n, i) => (n.kind === "tag" ? [{ tag: n, i, words: wordCount(n.children) }] : [])),
    [nodes],
  );
  const total = Math.max(1, ...sections.map((s) => s.words));
  const [closed, setClosed] = useState<ReadonlySet<number>>(new Set());
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const toggle = (i: number, open: boolean) =>
    setClosed((s) => {
      const next = new Set(s);
      if (open) next.delete(i);
      else next.add(i);
      return next;
    });
  const jump = (i: number) => {
    toggle(i, true);
    document.getElementById(sectionId(i))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const allClosed = sections.length > 0 && sections.every((s) => closed.has(s.i));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="-mx-2 flex items-center justify-end gap-1 [&>button]:h-7 [&>button]:px-2 [&>button]:text-xs">
        {sections.length && !raw ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted me-auto"
            onPress={() => setClosed(allClosed ? new Set() : new Set(sections.map((s) => s.i)))}
          >
            {allClosed ? "Expand all" : "Collapse all"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="text-muted" onPress={() => setRaw((r) => !r)}>
          {raw ? "Rendered" : "Source"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted"
          onPress={() => void navigator.clipboard.writeText(source).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      {raw ? (
        <CodeBlock code={source} lang="xml" />
      ) : (
        <>
          {sections.length > 1 ? (
            <nav aria-label="Prompt sections" className="border-border bg-surface rounded-sm border pb-1.5">
              <div className="border-separator mb-1.5 flex h-10 items-center justify-between border-b px-4">
                <span className="label-caps text-muted">Outline</span>
                <span className="text-muted font-mono text-xs tabular-nums">
                  {wordCount(nodes).toLocaleString()} words
                </span>
              </div>
              {sections.map((s) => (
                <button
                  key={s.i}
                  type="button"
                  onClick={() => jump(s.i)}
                  aria-label={`${titleOf(s.tag)}, ${s.words} words`}
                  className="hover:bg-default/60 focus-visible:ring-focus grid w-full cursor-pointer grid-cols-[7.5rem_minmax(0,1fr)_3rem] items-center gap-3 px-4 py-1 text-start outline-none focus-visible:ring-2 sm:grid-cols-[9rem_8rem_minmax(0,1fr)_3rem]"
                >
                  <span className="hidden truncate font-mono text-xs sm:block">
                    <span className="code-punctuation">&lt;</span>
                    <span className="code-keyword">{s.tag.name}</span>
                    <span className="code-punctuation">&gt;</span>
                  </span>
                  <span className="truncate text-sm">{titleOf(s.tag)}</span>
                  <Meter
                    aria-label={`${titleOf(s.tag)} share of the prompt`}
                    value={s.words}
                    maxValue={total}
                    size="sm"
                    className="w-full"
                  >
                    <Meter.Track>
                      <Meter.Fill />
                    </Meter.Track>
                  </Meter>
                  <span className="text-muted text-end font-mono text-xs tabular-nums">{s.words.toLocaleString()}</span>
                </button>
              ))}
            </nav>
          ) : null}
          {nodes.map((n, i) =>
            n.kind === "text" ? (
              <Prose key={i} text={n.text} />
            ) : (
              <Disclosure
                key={i}
                id={sectionId(i)}
                isExpanded={!closed.has(i)}
                onExpandedChange={(open) => toggle(i, open)}
                className="border-border bg-surface min-w-0 scroll-mt-4 rounded-sm border"
              >
                <Header tag={n} words={sections.find((s) => s.i === i)?.words} />
                <Body tag={n} depth={0} />
              </Disclosure>
            ),
          )}
        </>
      )}
    </div>
  );
}
