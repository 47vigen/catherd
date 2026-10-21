import { cn } from "@heroui/react";
import { useEffect, useState } from "react";
import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import json from "shiki/langs/json.mjs";

// Colours come from CSS variables in theme.css, so one highlighter serves light and dark.
const theme = createCssVariablesTheme({ name: "catherd", variablePrefix: "--code-", fontStyle: true });

let highlighter: Promise<HighlighterCore> | undefined;
const getHighlighter = () =>
  (highlighter ??= createHighlighterCore({ themes: [theme], langs: [json], engine: createJavaScriptRegexEngine() }));

/** Bodies larger than this stay plain: tokenising them would stall the drawer for little gain. */
const MAX_HIGHLIGHT = 200_000;

/** A read-only code panel with syntax colours; plain text shows first and while the grammar loads. */
export function CodeBlock({
  code,
  lang = "json",
  wrap = true,
  className,
}: {
  code: string;
  /** "text" shows the body as is, for streamed events or plain messages. */
  lang?: "json" | "text";
  wrap?: boolean;
  className?: string;
}) {
  const [lines, setLines] = useState<{ code: string; tokens: ThemedToken[][] }>();

  useEffect(() => {
    if (lang !== "json" || code.length > MAX_HIGHLIGHT) return;
    let live = true;
    void getHighlighter().then((h) => {
      if (live) setLines({ code, tokens: h.codeToTokensBase(code, { lang: "json", theme: "catherd" }) });
    });
    return () => {
      live = false;
    };
  }, [code, lang]);

  const tokens = lang === "json" && lines?.code === code ? lines.tokens : undefined;
  return (
    <pre
      dir={lang === "json" ? "ltr" : "auto"}
      className={cn(
        "bg-surface-secondary border-border text-foreground overflow-auto rounded-sm border p-3 font-mono text-xs leading-5",
        wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
        className,
      )}
    >
      <code>
        {tokens
          ? tokens.map((line, i) => (
              <span key={i}>
                {line.map((t, j) => (
                  <span key={j} className={tokenClass(t.color)}>
                    {t.content}
                  </span>
                ))}
                {i < tokens.length - 1 ? "\n" : null}
              </span>
            ))
          : code}
      </code>
    </pre>
  );
}

/** Maps the theme's `var(--code-token-*)` colour to a class, keeping inline styles out of the markup. */
function tokenClass(color: string | undefined): string | undefined {
  const m = color?.match(/--code-token-([a-z-]+)/);
  return m ? `code-${m[1]}` : undefined;
}
