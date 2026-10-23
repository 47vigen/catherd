import { cn, Surface } from "@heroui/react";
import type { ReactNode } from "react";

/** Axis text in the mono label voice, and the grid hairline; recharts takes these as props. */
export const AXIS_TICK = { fontSize: 10.5, fill: "var(--muted)", fontFamily: "var(--font-mono)" } as const;
export const GRID_STROKE = "var(--separator)";
export const CURSOR_FILL = { fill: "var(--surface-tertiary)", fillOpacity: 0.6 } as const;

function Root({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <Surface className="border-border shadow-overlay min-w-44 rounded-sm border px-3 py-2">
      <div className="label-caps text-muted mb-1.5">{title}</div>
      <div className="flex flex-col gap-1 text-sm">{children}</div>
    </Surface>
  );
}

/** One line of a tooltip; without a `swatch` it is the total, set off by a hairline. */
function Row({ swatch, label, value }: { swatch?: string; label: ReactNode; value: ReactNode }) {
  return (
    <div className={cn("flex items-center justify-between gap-4", !swatch && "border-border mt-0.5 border-t pt-1")}>
      <span className="flex items-center gap-1.5">
        {swatch ? <span aria-hidden="true" className={cn("size-2 rounded-[2px]", swatch)} /> : null}
        <span className={swatch ? "text-muted" : "font-medium"}>{label}</span>
      </span>
      <span className="font-mono text-xs font-medium tabular-nums">{value}</span>
    </div>
  );
}

export const ChartTooltip = Object.assign(Root, { Root, Row });
