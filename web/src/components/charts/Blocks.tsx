import { cn } from "@heroui/react";

const STEPS = 24;

/** A share as a row of blocks, so a bar needs no inline width; decorative, the figure beside it carries the value. */
export function Blocks({
  value,
  max,
  tone = "bg-accent",
  className,
}: {
  value: number;
  max: number;
  tone?: string;
  className?: string;
}) {
  const lit = max > 0 && value > 0 ? Math.max(1, Math.round((value / max) * STEPS)) : 0;
  return (
    <span aria-hidden="true" data-lit={lit} className={cn("flex h-1.5 gap-px", className)}>
      {Array.from({ length: STEPS }, (_, i) => (
        <span key={i} className={cn("flex-1 transition-colors duration-300", i < lit ? tone : "bg-surface-tertiary")} />
      ))}
    </span>
  );
}
