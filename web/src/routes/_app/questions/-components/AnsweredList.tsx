import { Link } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";

import { listAnsweredOptions } from "../../../../client/@tanstack/react-query.gen";
import { Term } from "../../../../components/term/Term";
import { Tile } from "../../../../components/tile/Tile";
import { formatRelative } from "../../../../lib/time";

/** What was answered in the last day, so an answer that just left the list is not lost. */
export function AnsweredList({ run, className }: { run?: string; className?: string }) {
  const answered = useQuery({ ...listAnsweredOptions({ query: { run } }), refetchInterval: 10_000 });
  const items = answered.data?.items ?? [];
  const now = new Date(answered.dataUpdatedAt);

  return (
    <Tile
      title="Recently answered"
      aside={<span className="text-muted font-mono text-[11px]">24h</span>}
      className={className}
    >
      {items.length === 0 ? (
        <p className="text-muted px-4 py-3 text-[13px]">
          {answered.isPending ? "Loading…" : "Nothing answered in the last day."}
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {items.map((a) => (
            <li key={`${a.run}/${a.unit}/${a.at}`} className="flex flex-col gap-1 px-4 py-2.5">
              <p className="line-clamp-2 text-[13px] leading-5 break-words">{a.answer}</p>
              <p className="text-muted flex min-w-0 items-center gap-1.5 text-xs">
                <Link
                  href={`/runs/${encodeURIComponent(a.run)}`}
                  className="text-muted hover:text-foreground min-w-0 truncate text-xs no-underline"
                >
                  {a.runTitle}
                </Link>
                <span aria-hidden="true">·</span>
                <span className="shrink-0 font-mono">{a.unit}</span>
                <span className="ml-auto shrink-0 whitespace-nowrap">
                  {a.by === "judge" ? <Term name="judge">Judge</Term> : "You"} · {formatRelative(a.at, now)}
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </Tile>
  );
}
