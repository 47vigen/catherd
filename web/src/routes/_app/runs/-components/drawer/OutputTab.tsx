import { Chip, cn } from "@heroui/react";

import type { DispatchDetail } from "../../../../../client";
import { CodeBlock } from "../../../../../components/code-block/CodeBlock";
import { Markdown } from "../../../../../components/markdown/Markdown";
import { Term } from "../../../../../components/term/Term";
import { Empty, type DispatchQuery, Section, WithDispatch } from "./parts";

const FINDING_COLOR = {
  IMPORTANT: "danger",
  BLOCKER: "danger",
  BUG: "warning",
  NIT: "default",
  "PRE-EXISTING": "default",
} as const;

function Findings({ findings }: { findings: DispatchDetail["findings"] }) {
  return (
    <Section title="Findings" aside={<span className="text-muted text-xs">{findings.length}</span>}>
      <ul aria-label="Findings" className="border-border divide-separator divide-y rounded-sm border">
        {findings.map((f, i) => (
          <li key={i} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-3 px-3 py-2.5 text-[13px]">
            <Chip size="sm" variant="soft" color={FINDING_COLOR[f.label]} className="w-fit">
              <Chip.Label className="font-mono text-[10px]">{f.label}</Chip.Label>
            </Chip>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="leading-5 break-words">{f.text}</span>
              {f.class || f.file ? (
                <span className="text-muted flex flex-wrap gap-x-2 text-xs">
                  {f.class ? <span>{f.class}</span> : null}
                  {f.file ? <span className="font-mono">{f.file}</span> : null}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ALines({ lines }: { lines: DispatchDetail["aLines"] }) {
  const passed = lines.filter((l) => l.pass).length;
  return (
    <Section
      title={<Term name="A-line">A-lines</Term>}
      label="A-lines"
      aside={
        <span
          className={cn("font-mono text-xs tabular-nums", passed === lines.length ? "text-success" : "text-danger")}
        >
          {passed}/{lines.length} pass
        </span>
      }
    >
      <ul aria-label="A-lines" className="border-border divide-separator divide-y rounded-sm border">
        {lines.map((l) => (
          <li
            key={l.id}
            className="grid grid-cols-[3.25rem_2.5rem_minmax(0,1fr)] items-start gap-3 px-3 py-2.5 text-[13px]"
          >
            <Chip size="sm" variant="soft" color={l.pass ? "success" : "danger"} className="w-fit">
              <Chip.Label className="font-mono text-[10px]">{l.pass ? "PASS" : "FAIL"}</Chip.Label>
            </Chip>
            <span className="text-muted font-mono text-xs leading-5">{l.id}</span>
            <span className="min-w-0 leading-5 break-words">{l.text}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** What the role answered: the findings and A-lines parsed from it first, then its reply, then any error output. */
export function OutputTab({ dispatch }: { dispatch: DispatchQuery }) {
  return (
    <WithDispatch dispatch={dispatch} none="No reply yet.">
      {(d) => (
        <>
          {d.findings.length > 0 ? <Findings findings={d.findings} /> : null}
          {d.aLines.length > 0 ? <ALines lines={d.aLines} /> : null}
          {d.reply ? (
            <Section title="Reply">
              {d.truncated.includes("reply") ? (
                <p className="text-muted text-xs">The reply is long, so only its start is shown.</p>
              ) : null}
              <div className="border-border rounded-sm border px-4 py-3">
                <Markdown source={d.reply} />
              </div>
            </Section>
          ) : (
            <Empty>No reply yet.</Empty>
          )}
          {d.stderr ? (
            <details className="group border-border rounded-sm border">
              <summary className="text-muted hover:text-foreground cursor-pointer px-3 py-2 text-[13px] select-none">
                Error output
              </summary>
              <CodeBlock code={d.stderr} lang="text" className="max-h-80 rounded-none border-0 border-t" />
            </details>
          ) : null}
        </>
      )}
    </WithDispatch>
  );
}
