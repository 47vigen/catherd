import { cn } from "@heroui/react";

import { brandOfModel, effortsOf, nameOfModel, peak, shadesOf } from "../-lib/series";
import type { CatalogEntry } from "../../../../client";
import { brandShade } from "../../../../lib/brand";

const money = (v: number) =>
  v >= 10 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${Number(v.toPrecision(2))}`;

/**
 * Every model against every effort: the score and the price per task in one cell, the strongest of each column
 * marked. It is the table to read when picking a role's rungs.
 */
export function EffortTable({ models, hidden }: { models: CatalogEntry[]; hidden: ReadonlySet<string> }) {
  const shown = models.filter((m) => !hidden.has(m.id)).toSorted((a, b) => peak(b) - peak(a));
  const efforts = effortsOf(shown);
  const shades = shadesOf(models);
  const best = new Map(
    efforts.map((e) => [e, Math.max(...shown.map((m) => m.points.find((p) => p.effort === e)?.intelligence ?? -1))]),
  );
  if (shown.length === 0) return <p className="text-muted px-4 py-3 text-sm">Switch a model on to compare it.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-[13px]">
        <thead>
          <tr className="border-border border-b">
            <th scope="col" className="label-caps text-muted px-4 py-2.5 text-left font-normal">
              Model
            </th>
            {efforts.map((e) => (
              <th key={e} scope="col" className="label-caps text-muted px-3 py-2.5 text-right font-normal">
                {e}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-separator divide-y">
          {shown.map((m) => (
            <tr key={m.id} className="hover:bg-surface-secondary/50 transition-colors">
              <th scope="row" className="px-4 py-2 text-left font-normal whitespace-nowrap">
                <span className="flex items-center gap-2">
                  <svg aria-hidden="true" className="size-2.5 shrink-0">
                    <rect width="100%" height="100%" rx="2" fill={brandShade(brandOfModel(m), shades.get(m.id)!)} />
                  </svg>
                  {nameOfModel(m)}
                </span>
              </th>
              {efforts.map((e) => {
                const p = m.points.find((x) => x.effort === e);
                const top = p && p.intelligence === best.get(e);
                return (
                  <td key={e} className="px-3 py-2 text-right tabular-nums">
                    {p ? (
                      <span className="inline-flex flex-col items-end leading-tight">
                        <span className={cn("font-mono", top ? "text-accent font-medium" : "text-foreground")}>
                          {p.intelligence.toFixed(1)}
                        </span>
                        <span
                          className="text-muted font-mono text-[11px]"
                          title={p.measured ? "measured" : "estimated"}
                        >
                          {p.usd === null ? "–" : money(p.usd)}
                          {p.usd !== null && !p.measured ? "*" : ""}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted/50">·</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
