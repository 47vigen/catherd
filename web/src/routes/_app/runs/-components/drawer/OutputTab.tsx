import { Chip } from "@heroui/react";

import type { DispatchDetail } from "../../../../../client";
import { CodeBlock } from "../../../../../components/code-block/CodeBlock";
import { Markdown } from "../../../../../components/markdown/Markdown";
import { Term } from "../../../../../components/term/Term";
import { Empty, type DispatchQuery, WithDispatch } from "./parts";

const FINDING_COLOR = {
  IMPORTANT: "danger",
  BLOCKER: "danger",
  BUG: "warning",
  NIT: "default",
  "PRE-EXISTING": "default",
} as const;

function Findings({ findings }: { findings: DispatchDetail["findings"] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="label-caps text-muted">Findings</h3>
      <ul aria-label="Findings" className="border-border bg-surface divide-border divide-y rounded-sm border">
        {findings.map((f, i) => (
          <li key={i} className="flex items-start gap-3 px-3 py-2 text-[13px]">
            <Chip size="sm" variant="soft" color={FINDING_COLOR[f.label]} className="mt-0.5 shrink-0">
              <Chip.Label className="text-[10px]">{f.label}</Chip.Label>
            </Chip>
            {f.class ? <span className="text-muted shrink-0 text-xs">{f.class}</span> : null}
            <span className="min-w-0 flex-1 break-words">
              {f.text}
              {f.file ? <span className="text-muted ms-2 font-mono text-xs">{f.file}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ALines({ lines }: { lines: DispatchDetail["aLines"] }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="label-caps text-muted">
        <Term name="A-line">A-lines</Term>
      </h3>
      <ul aria-label="A-lines" className="border-border bg-surface divide-border divide-y rounded-sm border">
        {lines.map((l) => (
          <li key={l.id} className="flex items-start gap-3 px-3 py-2 text-[13px]">
            <Chip size="sm" variant="soft" color={l.pass ? "success" : "danger"} className="mt-0.5 shrink-0">
              <Chip.Label className="text-[10px]">{l.pass ? "PASS" : "FAIL"}</Chip.Label>
            </Chip>
            <span className="text-muted shrink-0 font-mono text-xs leading-5">{l.id}</span>
            <span className="min-w-0 flex-1 break-words">{l.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What the role answered: its reply, the findings parsed from it, and a verifier's A-lines. */
export function OutputTab({ dispatch }: { dispatch: DispatchQuery }) {
  return (
    <WithDispatch dispatch={dispatch} none="No reply yet.">
      {(d) => (
        <div className="flex flex-col gap-4">
          {d.findings.length > 0 ? <Findings findings={d.findings} /> : null}
          {d.aLines.length > 0 ? <ALines lines={d.aLines} /> : null}
          {d.reply ? (
            <section className="flex flex-col gap-2">
              <h3 className="label-caps text-muted">Reply</h3>
              {d.truncated.includes("reply") ? (
                <p className="text-muted text-xs">The reply is long, so only its start is shown.</p>
              ) : null}
              <Markdown source={d.reply} />
            </section>
          ) : (
            <Empty>No reply yet.</Empty>
          )}
          {d.stderr ? (
            <details className="flex flex-col gap-2">
              <summary className="text-muted cursor-pointer text-sm">Error output</summary>
              <CodeBlock code={d.stderr} lang="text" className="mt-2 max-h-80" />
            </details>
          ) : null}
        </div>
      )}
    </WithDispatch>
  );
}
