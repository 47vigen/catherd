import { Label, Switch } from "@heroui/react";

import { brandOfModel, nameOfModel, peak, shadesOf } from "../-lib/series";
import type { CatalogEntry } from "../../../../client";
import { Blocks } from "../../../../components/charts/Blocks";
import { ProviderIcon, providerOf } from "../../../../components/provider-icon/ProviderIcon";
import { BRAND_TEXT, brandOf, brandShade } from "../../../../lib/brand";

function costNote(m: CatalogEntry): string {
  const costed = m.points.filter((p) => p.usd !== null);
  if (costed.length === 0) return "No cost known";
  const estimated = costed.filter((p) => !p.measured).length;
  return estimated === 0 ? "All costs measured" : `${estimated} of ${costed.length} costs estimated`;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** Every available model: its best score, how much of our work it did lately, and a switch for its line. */
export function ModelList({
  models,
  hidden,
  onToggle,
  usage,
}: {
  models: CatalogEntry[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** tokens each model used in the recent window, by model id */
  usage?: ReadonlyMap<string, number>;
}) {
  const shades = shadesOf(models);
  const most = Math.max(0, ...(usage?.values() ?? []));
  return (
    <ul className="divide-border divide-y">
      {/* strongest first; models a newer version replaces (off by default) go last. Sorted on that default, not the
          switch, so a row never jumps away from the pointer that flipped it. */}
      {models
        .toSorted((a, b) => Number(a.superseded) - Number(b.superseded) || peak(b) - peak(a))
        .map((m) => {
          const marks = [...new Map(m.backends.map((b) => [providerOf(b) ?? b, b])).values()];
          return (
            <li
              key={m.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
              data-superseded={m.superseded || undefined}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                {/* the line's own shade; an svg fill, since a computed colour cannot be a class */}
                <svg aria-hidden="true" className="size-2.5 shrink-0">
                  <rect width="100%" height="100%" rx="2" fill={brandShade(brandOfModel(m), shades.get(m.id)!)} />
                </svg>
                <div className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5 text-sm">
                    <span className="truncate">{nameOfModel(m)}</span>
                    {marks.map((b) => (
                      <ProviderIcon key={b} backend={b} size="xs" className={BRAND_TEXT[brandOf(b)]} />
                    ))}
                  </span>
                  <span className="text-muted flex gap-1.5 text-xs">
                    <span>
                      <span className="text-foreground font-mono tabular-nums">{peak(m).toFixed(1)}</span> best
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{costNote(m)}</span>
                  </span>
                  {usage?.get(m.id) ? (
                    <span className="mt-1 flex items-center gap-2" title="Tokens in the last 30 days">
                      <Blocks value={usage.get(m.id)!} max={most} className="w-24" />
                      <span className="text-muted font-mono text-[10.5px] tabular-nums">
                        {compact.format(usage.get(m.id)!)} used
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>
              <Switch size="sm" isSelected={!hidden.has(m.id)} onChange={() => onToggle(m.id)}>
                <Switch.Content>
                  <Label className="sr-only">{nameOfModel(m)}</Label>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
            </li>
          );
        })}
    </ul>
  );
}
