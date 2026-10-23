import { cn } from "@heroui/react";
import { useEffect, useState } from "react";
import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Colours come from CSS variables in theme.css, so one highlighter serves light and dark.
const theme = createCssVariablesTheme({ name: "catherd", variablePrefix: "--code-", fontStyle: true });

/** Grammars load on first use, each as its own chunk, so a page that shows only JSON never pays for the rest. */
const GRAMMARS = {
  json: () => import("shiki/langs/json.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};
type Grammar = keyof typeof GRAMMARS;
export type CodeLang = Grammar | "text";

const ALIASES: Record<string, Grammar> = {
  md: "markdown",
  ts: "typescript",
  js: "javascript",
  mjs: "javascript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  patch: "diff",
  yml: "yaml",
  jsonc: "json",
};

/** A fence name (any case, with its common aliases) to a grammar; anything unknown is plain text. */
export function normalizeLang(lang: string | undefined): CodeLang {
  const name = (lang ?? "").toLowerCase();
  const alias = ALIASES[name] ?? name;
  return alias in GRAMMARS ? (alias as Grammar) : "text";
}

let highlighter: Promise<HighlighterCore> | undefined;
const getHighlighter = () =>
  (highlighter ??= createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine() }));

async function tokenize(code: string, lang: Grammar): Promise<ThemedToken[][]> {
  const h = await getHighlighter();
  await h.loadLanguage(GRAMMARS[lang]());
  return h.codeToTokensBase(code, { lang, theme: "catherd" });
}

/** Bodies larger than this stay plain: tokenising them would stall the drawer for little gain. */
const MAX_HIGHLIGHT = 200_000;

const DIFF_LINE = { added: "bg-success/10", removed: "bg-danger/10", hunk: "bg-surface-tertiary text-muted" } as const;
const diffKind = (line: string): keyof typeof DIFF_LINE | undefined =>
  line.startsWith("@@")
    ? "hunk"
    : line.startsWith("+") && !line.startsWith("+++")
      ? "added"
      : line.startsWith("-") && !line.startsWith("---")
        ? "removed"
        : undefined;

/** A read-only code panel with syntax colours; plain text shows first and while the grammar loads. */
export function CodeBlock({
  code,
  lang = "json",
  wrap = true,
  className,
}: {
  code: string;
  /** A grammar or an alias ("ts", "sh", "md"...); "text" and anything unknown show the body as is. */
  lang?: string;
  wrap?: boolean;
  className?: string;
}) {
  const grammar = normalizeLang(lang);
  const [lines, setLines] = useState<{ code: string; lang: string; tokens: ThemedToken[][] }>();

  useEffect(() => {
    if (grammar === "text" || code.length > MAX_HIGHLIGHT) return;
    let live = true;
    void tokenize(code, grammar).then((tokens) => {
      if (live) setLines({ code, lang: grammar, tokens });
    });
    return () => {
      live = false;
    };
  }, [code, grammar]);

  const tokens = lines?.code === code && lines.lang === grammar ? lines.tokens : undefined;
  const diff = grammar === "diff";
  // Rows are always spans with a newline between, so plain and highlighted text lay out the same.
  const rows: ThemedToken[][] | string[] = tokens ?? (diff ? code.split("\n") : []);
  return (
    <pre
      dir={grammar === "text" ? "auto" : "ltr"}
      className={cn(
        "bg-surface-secondary border-border text-foreground overflow-auto rounded-sm border p-3 font-mono text-xs leading-5",
        wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
        className,
      )}
    >
      <code>
        {rows.length === 0
          ? code
          : rows.map((row, i) => {
              const text = typeof row === "string" ? row : row.map((t) => t.content).join("");
              const kind = diff ? diffKind(text) : undefined;
              return (
                <span key={i} data-line={kind} className={cn(kind && cn("-mx-3 block px-3", DIFF_LINE[kind]))}>
                  {typeof row === "string"
                    ? row
                    : row.map((t, j) => (
                        <span key={j} className={tokenClass(t.color)}>
                          {t.content}
                        </span>
                      ))}
                  {kind || i === rows.length - 1 ? null : "\n"}
                </span>
              );
            })}
      </code>
    </pre>
  );
}

/** Maps the theme's `var(--code-token-*)` colour to a class, keeping inline styles out of the markup. */
function tokenClass(color: string | undefined): string | undefined {
  const m = color?.match(/--code-token-([a-z-]+)/);
  if (m?.[1] === "inserted") return "text-success";
  if (m?.[1] === "deleted") return "text-danger";
  return m ? `code-${m[1]}` : undefined;
}
