import { Chip } from "@heroui/react";

import type { NodeDecision } from "../../../../../client";
import { RungLine } from "./OverviewTab";
import { Empty } from "./parts";

const SOURCE: Record<NodeDecision["source"], string> = {
  model: "Decision model",
  floor: "Floor",
  failover: "Failover",
  coordinator: "Coordinator",
};

/** How the rung of a dispatch was chosen: the levels weakest first, the picked one marked, and the reason given. */
export function DecisionTab({ decision }: { decision: NodeDecision | null | undefined }) {
  if (!decision) return <Empty>Not decided yet</Empty>;
  return (
    <div className="flex flex-col gap-4">
      <ol aria-label="Levels" className="border-border bg-surface divide-border divide-y rounded-sm border">
        {decision.levelRungs.map((rungs, level) => (
          <li key={level} className="flex items-start gap-3 px-3 py-2 text-[13px]">
            <span className="label-caps text-muted w-14 shrink-0 pt-0.5">Level {level + 1}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              {rungs.map((r) => (
                <RungLine key={r} rung={r} />
              ))}
            </span>
            {level === decision.level ? (
              <Chip size="sm" variant="soft" color="accent" className="mt-0.5 shrink-0">
                <Chip.Label className="text-[10px]">Picked</Chip.Label>
              </Chip>
            ) : null}
          </li>
        ))}
      </ol>
      <dl className="bg-border border-border grid grid-cols-2 gap-px overflow-hidden rounded-sm border">
        <div className="bg-surface flex flex-col gap-1 px-3 py-2.5">
          <dt className="label-caps text-muted">Probability</dt>
          <dd className="text-[13px] tabular-nums">{decision.p === null ? "–" : `${Math.round(decision.p * 100)}%`}</dd>
        </div>
        <div className="bg-surface flex flex-col gap-1 px-3 py-2.5">
          <dt className="label-caps text-muted">Source</dt>
          <dd className="text-[13px]">{SOURCE[decision.source]}</dd>
        </div>
      </dl>
      {decision.why ? (
        <section className="flex flex-col gap-2">
          <h3 className="label-caps text-muted">Why</h3>
          <p className="text-sm leading-6 break-words whitespace-pre-wrap">{decision.why}</p>
        </section>
      ) : null}
    </div>
  );
}
