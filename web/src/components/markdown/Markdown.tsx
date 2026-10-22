import { Button, cn } from "@heroui/react";
import { Children, isValidElement, type ReactNode, useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeBlock } from "../code-block/CodeBlock";

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

/** A fenced block goes through CodeBlock (JSON gets colours; any other language shows as plain text). */
function Fence({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children)[0];
  const props = isValidElement<{ className?: string; children?: ReactNode }>(code) ? code.props : undefined;
  const lang = /language-(\S+)/.exec(props?.className ?? "")?.[1];
  return (
    <CodeBlock
      code={textOf(props?.children ?? children).replace(/\n$/, "")}
      lang={lang === "json" ? "json" : "text"}
      className="my-3"
    />
  );
}

const heading =
  (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6", className: string) =>
  ({ children }: { children?: ReactNode }) => <Tag className={className}>{children}</Tag>;

// Raw HTML from an agent is never rendered: react-markdown escapes it, and no rehype-raw is added.
const COMPONENTS: Components = {
  h1: heading("h1", "mt-5 mb-2 text-lg font-semibold tracking-tight first:mt-0"),
  h2: heading("h2", "mt-5 mb-2 text-base font-semibold tracking-tight first:mt-0"),
  h3: heading("h3", "mt-4 mb-1.5 text-sm font-semibold first:mt-0"),
  h4: heading("h4", "label-caps text-muted mt-4 mb-1.5 first:mt-0"),
  h5: heading("h5", "mt-3 mb-1 text-sm font-medium"),
  h6: heading("h6", "text-muted mt-3 mb-1 text-sm font-medium"),
  p: (p) => <p className="my-2 first:mt-0 last:mb-0" {...strip(p)} />,
  ul: (p) => <ul className="marker:text-muted my-2 list-disc ps-5" {...strip(p)} />,
  ol: (p) => <ol className="marker:text-muted my-2 list-decimal ps-5" {...strip(p)} />,
  li: (p) => <li className="my-0.5 ps-0.5" {...strip(p)} />,
  blockquote: (p) => <blockquote className="border-border text-muted my-3 border-s-2 ps-3" {...strip(p)} />,
  hr: () => <hr className="border-border my-4" />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-link underline underline-offset-2">
      {children}
    </a>
  ),
  strong: (p) => <strong className="font-semibold" {...strip(p)} />,
  code: ({ children }) => (
    <code className="bg-surface-tertiary rounded-sm px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => <Fence>{children}</Fence>,
  table: (p) => (
    <div className="border-border my-3 overflow-x-auto rounded-sm border">
      <table className="w-full border-collapse text-left text-[13px]" {...strip(p)} />
    </div>
  ),
  thead: (p) => <thead className="bg-surface-secondary" {...strip(p)} />,
  th: (p) => <th className="label-caps text-muted border-border border-b px-3 py-2 font-medium" {...strip(p)} />,
  td: (p) => <td className="border-separator border-b px-3 py-2 align-top last-of-type:border-b-0" {...strip(p)} />,
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
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="ghost" onPress={() => setRaw((r) => !r)}>
          {raw ? "Rendered" : "Source"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onPress={() => void navigator.clipboard.writeText(source).then(() => setCopied(true))}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {raw ? (
        <CodeBlock code={source} lang="text" />
      ) : (
        <div dir="auto" className="min-w-0 text-sm leading-6 break-words">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
            {source}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
