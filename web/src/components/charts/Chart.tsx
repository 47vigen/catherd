import type { ReactNode } from "react";

/** Series fills, in the order of `--chart-1` … `--chart-5`; class names stay literal so Tailwind sees them. */
export const SERIES_FILL = ["fill-chart-1", "fill-chart-2", "fill-chart-3", "fill-chart-4", "fill-chart-5"] as const;
export const SERIES_BG = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"] as const;

/** The frame of a small chart: its title, the one line on what it tells you, then the drawing. */
export function Chart({ title, meaning, children }: { title: string; meaning: string; children: ReactNode }) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="flex flex-col gap-0.5">
        <span className="label-caps text-muted">{title}</span>
        <span className="text-muted text-xs">{meaning}</span>
      </figcaption>
      {children}
    </figure>
  );
}

export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
