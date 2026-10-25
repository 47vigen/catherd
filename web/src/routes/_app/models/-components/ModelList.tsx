import { Label, Switch } from "@heroui/react";

import { brandOfModel, nameOfModel, peak, shadesOf } from "../-lib/series";
import type { CatalogEntry } from "../../../../client";
import { ProviderIcon, providerOf } from "../../../../components/provider-icon/ProviderIcon";
import { BRAND_TEXT, brandOf, brandShade } from "../../../../lib/brand";

function costNote(m: CatalogEntry): string {
  const costed = m.points.filter((p) => p.usd !== null);
  if (costed.length === 0) return "No cost known";
  const estimated = costed.filter((p) => !p.measured).length;
  return estimated === 0 ? "All costs measured" : `${estimated} of ${costed.length} costs estimated`;
}

/** Every available model with a switch that draws or hides its line. */
export function ModelList({
  models,
  hidden,
  onToggle,
}: {
  models: CatalogEntry[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const shades = shadesOf(models);
  return (
    <ul className="divide-border divide-y">
      {/* strongest first; models a newer version replaces (off by default) go last. Sorted on that default, not the
          switch, so a row never jumps away from the pointer that flipped it. */}
      {models
        .toSorted((a, b) => Number(a.superseded) - Number(b.superseded) || peak(b) - peak(a))
        .map((m) => {
          const marks = [...new Map(m.backends.map((b) => [providerOf(b) ?? b, b])).values()];
          return (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
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
                  <span className="text-muted text-xs">{costNote(m)}</span>
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
