import { Accordion, type Key, Spinner } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getRunDocOptions } from "../../../../client/@tanstack/react-query.gen";
import { Markdown } from "../../../../components/markdown/Markdown";

const DOCS = [
  { id: "plan.md", title: "Plan", empty: "No plan yet." },
  { id: "report.md", title: "Report", empty: "No report yet." },
] as const;

// A document is read only once it is open; a missing one answers 404, which here just means "not written yet".
function DocBody({ runId, name, empty }: { runId: string; name: string; empty: string }) {
  const doc = useQuery(getRunDocOptions({ path: { id: runId }, query: { name } }));
  if (doc.isPending) return <Spinner size="sm" />;
  if (doc.isError || doc.data.text.trim() === "") return <p className="text-muted text-sm">{empty}</p>;
  return <Markdown source={doc.data.text} />;
}

/** The plan and the report of a run, rendered. The report opens first once the run has ended. */
export function RunDocs({ runId, ended, only }: { runId: string; ended: boolean; only?: "report.md" }) {
  const docs = DOCS.filter((d) => !only || d.id === only);
  const [open, setOpen] = useState<Set<Key>>(new Set([ended ? "report.md" : "plan.md"]));
  return (
    <Accordion
      variant="surface"
      allowsMultipleExpanded
      expandedKeys={open}
      onExpandedChange={setOpen}
      aria-label="Plan and report"
    >
      {docs.map((d) => (
        <Accordion.Item key={d.id} id={d.id}>
          <Accordion.Heading>
            <Accordion.Trigger>
              {d.title}
              <Accordion.Indicator />
            </Accordion.Trigger>
          </Accordion.Heading>
          <Accordion.Panel>
            <Accordion.Body>
              {open.has(d.id) ? <DocBody runId={runId} name={d.id} empty={d.empty} /> : null}
            </Accordion.Body>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}
