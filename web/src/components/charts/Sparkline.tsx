import { cn } from "@heroui/react";

/** A small line of a series, scaled to its own peak; decorative, the figure beside it carries the value. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 0);
  const step = 100 / (values.length - 1);
  // A flat series sits on the floor instead of being stretched to the peak.
  const y = (v: number) => (max > 0 ? 28 - (v / max) * 25 : 28).toFixed(2);
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${y(v)}`).join(" ");
  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-slot="sparkline"
      className={cn("h-7 w-full overflow-visible", className)}
    >
      <polyline points={`0,30 ${points} 100,30`} className="fill-accent/12 stroke-none" />
      <polyline
        points={points}
        className="stroke-accent fill-none"
        strokeWidth="1.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
