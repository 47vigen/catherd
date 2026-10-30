import { CircleExclamation, TriangleExclamation } from "@gravity-ui/icons";
import { cn, Link } from "@heroui/react";

import { Tile } from "../../../components/tile/Tile";
import type { RangeFinding } from "./insights";

const ICON = { danger: CircleExclamation, warning: TriangleExclamation, neutral: null } as const;
const TONE = { danger: "text-danger", warning: "text-warning", neutral: "text-muted" } as const;

/** The range's stories, worst first; each opens the run it is about. */
export function StandsOut({ items, days, className }: { items: RangeFinding[]; days: number; className?: string }) {
  return (
    <Tile
      title="What stands out"
      aside={<span className="text-muted font-mono text-xs">{days}d</span>}
      className={className}
    >
      {items.length === 0 ? (
        <p className="text-muted flex flex-1 items-center justify-center p-4 text-center text-sm">
          Nothing stands out: no failure, no long wait, no outlier.
        </p>
      ) : (
        <ul aria-label="What stands out" className="divide-separator divide-y">
          {items.map((f) => {
            const Icon = ICON[f.tone];
            const body = (
              <>
                <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center", TONE[f.tone])}>
                  {Icon ? (
                    <Icon aria-hidden="true" className="size-4" />
                  ) : (
                    <span aria-hidden="true" className="bg-muted size-1.5 rounded-full" />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-foreground text-[13px] font-medium">{f.title}</span>
                  {f.detail ? <span className="text-muted truncate text-[11px]">{f.detail}</span> : null}
                </span>
              </>
            );
            return (
              <li key={f.id} data-tone={f.tone}>
                {f.run ? (
                  <Link
                    href={`/runs/${encodeURIComponent(f.run)}`}
                    className="hover:bg-surface-secondary flex w-full items-start gap-3 px-4 py-3 no-underline transition-colors"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex items-start gap-3 px-4 py-3">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Tile>
  );
}
