import { Button, cn } from "@heroui/react";
import { Children, isValidElement, type ReactNode, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeBlock, normalizeLang } from "../code-block/CodeBlock";

const textOf = (node: ReactNode): string =>
  Children.toArray(node)
    .map((c) =>
      typeof c === "string" || typeof c === "number"
        ? String(c)
        : isValidElement<{ children?: ReactNode }>(c)
          ? textOf(c.props.children)
          : "",
    )
    .join("");

/** A fenced block goes through CodeBlock (a known language gets colours; any other shows as plain text). */
function Fence({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children)[0];
  const props = isValidElement<{ className?: string; children?: ReactNode }>(code) ? code.props : undefined;
  const lang = /language-(\S+)/.exec(props?.className ?? "")?.[1];
  return (
    <CodeBlock
      code={textOf(props?.children ?? children).replace(/\n$/, "")}
      lang={normalizeLang(lang)}
      className="my-3"
    />
  );
}

const heading =
  (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6", className: string) =>
  ({ children }: { children?: ReactNode }) => <Tag className={className}>{children}</Tag>;

// Raw HTML from an agent is never rendered: react-markdown escapes it, and no rehype-raw is added.
export const COMPONENTS: Components = {
  h1: heading("h1", "mt-8 mb-3 text-xl leading-7 font-semibold tracking-[-0.02em] first:mt-0"),
  h2: heading(
    "h2",
    "border-separator mt-8 mb-3 border-b pb-2 text-base leading-6 font-semibold tracking-[-0.01em] first:mt-0",
  ),
  h3: heading("h3", "mt-6 mb-2 text-sm leading-6 font-semibold first:mt-0"),
  h4: heading("h4", "label-caps text-muted mt-5 mb-2 first:mt-0"),
  h5: heading("h5", "mt-4 mb-1 text-sm font-medium"),
  h6: heading("h6", "text-muted mt-4 mb-1 text-sm font-medium"),
  // Agents write one fact per line without blank lines between: a single line break is kept, not run together.
  p: (p) => <p className="my-3 whitespace-pre-line first:mt-0 last:mb-0" {...strip(p)} />,
  ul: (p) => <ul className="marker:text-muted my-3 flex list-disc flex-col gap-1.5 ps-5" {...strip(p)} />,
  ol: (p) => <ol className="marker:text-muted my-3 flex list-decimal flex-col gap-1.5 ps-5" {...strip(p)} />,
  li: (p) => <li className="ps-1 [&>ol]:my-1.5 [&>p]:my-1 [&>ul]:my-1.5" {...strip(p)} />,
  blockquote: (p) => <blockquote className="border-border text-muted my-4 border-s-2 ps-4" {...strip(p)} />,
  hr: () => <hr className="border-separator my-6" />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-link underline underline-offset-2">
      {children}
    </a>
  ),
  strong: (p) => <strong className="font-semibold" {...strip(p)} />,
  code: ({ children }) => (
    <code className="bg-surface-tertiary rounded-sm px-1 py-px font-mono text-[0.85em] break-words">{children}</code>
  ),
  pre: ({ children }) => <Fence>{children}</Fence>,
  table: (p) => (
    <div className="border-border my-4 overflow-x-auto rounded-sm border">
      <table className="w-full border-collapse text-left text-[13px]" {...strip(p)} />
    </div>
  ),
  thead: (p) => <thead className="bg-surface-secondary" {...strip(p)} />,
  th: (p) => <th className="label-caps text-muted border-border border-b px-3 py-2 font-medium" {...strip(p)} />,
  td: (p) => (
    <td className="border-separator border-b px-3 py-2 align-top [tr:last-child>&]:border-b-0" {...strip(p)} />
  ),
  img: ({ alt, src }) => <img alt={alt ?? ""} src={src} className="my-3 h-auto max-w-full rounded-sm" />,
};

/** Drops react-markdown's `node` prop so it never reaches the DOM. */
function strip<T extends object>(p: T): Omit<T, "node"> {
  const { node: _node, ...rest } = p as T & { node?: unknown };
  return rest;
}

/** Markdown from an agent or a doc, rendered, with a toggle to its source and a copy button. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className={cn("min-w-0 flow-root", className)}>
      {/* Floated, so the first heading sits beside the buttons instead of under an empty row. */}
      <div className="float-end ms-4 mb-2 flex gap-1 [&>button]:h-7 [&>button]:px-2 [&>button]:text-xs">
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
        <CodeBlock code={source} lang="markdown" className="clear-both" />
      ) : (
        <div dir="auto" className="text-foreground min-w-0 text-sm leading-6 break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
            {source}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
