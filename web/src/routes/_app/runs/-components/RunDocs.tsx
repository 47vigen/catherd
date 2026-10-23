import { type Key, Spinner, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getRunDocOptions } from "../../../../client/@tanstack/react-query.gen";
import { Markdown } from "../../../../components/markdown/Markdown";
import { Tile } from "../../../../components/tile/Tile";

const DOCS = [
  { id: "report.md", title: "Report", empty: "No report yet. It is written when the run ends." },
  { id: "plan.md", title: "Plan", empty: "No plan yet. The architect writes it first." },
] as const;
type Doc = (typeof DOCS)[number]["id"];

// A missing document answers 404, which here just means "not written yet".
function DocBody({ runId, name, empty }: { runId: string; name: string; empty: string }) {
  const doc = useQuery(getRunDocOptions({ path: { id: runId }, query: { name } }));
  if (doc.isPending)
    return (
      <div className="flex justify-center py-10">
        <Spinner size="sm" />
      </div>
    );
  if (doc.isError || doc.data.text.trim() === "") return <p className="text-muted py-6 text-sm">{empty}</p>;
  return <Markdown source={doc.data.text} />;
}

/** The plan and the report of a run in one tile; the report shows first once the run has ended. */
export function RunDocs({
  runId,
  ended,
  only,
  className,
}: {
  runId: string;
  ended: boolean;
  only?: "report.md";
  className?: string;
}) {
  const docs = DOCS.filter((d) => !only || d.id === only);
  const [shown, setShown] = useState<Doc>(ended ? "report.md" : "plan.md");
  const doc = docs.find((d) => d.id === shown) ?? docs[0]!;
  return (
    <Tile
      title={docs.length === 1 ? doc.title : "Plan and report"}
      className={className}
      bodyClassName="px-5 py-4"
      aside={
        docs.length > 1 ? (
          <ToggleButtonGroup
            size="sm"
            aria-label="Document"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set<Key>([doc.id])}
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next) setShown(next as Doc);
            }}
          >
            {docs.map((d, i) => (
              <ToggleButton key={d.id} id={d.id}>
                {i > 0 ? <ToggleButtonGroup.Separator /> : null}
                {d.title}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        ) : null
      }
    >
      <DocBody key={doc.id} runId={runId} name={doc.id} empty={doc.empty} />
    </Tile>
  );
}
