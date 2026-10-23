import { Link } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";

import { listAnsweredOptions } from "../../../../client/@tanstack/react-query.gen";
import { SectionLabel } from "../../../../components/page-header/PageHeader";
import { Term } from "../../../../components/term/Term";
import { formatRelative } from "../../../../lib/time";

/** What was answered in the last day, so an answer that just left the list is not lost. Nothing answered, nothing shown. */
export function AnsweredList({ run }: { run?: string }) {
  const answered = useQuery({ ...listAnsweredOptions({ query: { run } }), refetchInterval: 10_000 });
  const items = answered.data?.items ?? [];
  if (items.length === 0) return null;
  const now = new Date(answered.dataUpdatedAt);

  return (
    <section className="flex flex-col gap-2">
      <SectionLabel aside={<span className="text-muted text-xs">Last 24 hours</span>}>Recently answered</SectionLabel>
      <ul className="border-border bg-surface divide-border divide-y rounded-sm border">
        {items.map((a) => (
          <li
            key={`${a.run}/${a.unit}/${a.at}`}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-[13px]"
          >
            <Link href={`/runs/${encodeURIComponent(a.run)}`} className="font-medium">
              {a.runTitle}
            </Link>
            <span className="text-muted font-mono text-xs">{a.unit}</span>
            <span className="line-clamp-2 min-w-0 flex-1 basis-60 break-words">{a.answer}</span>
            <span className="text-muted whitespace-nowrap">
              {a.by === "judge" ? <Term name="judge">Judge</Term> : "You"} · {formatRelative(a.at, now)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
