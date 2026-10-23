import { Meter as HeroMeter } from "@heroui/react";

/** A 0 to 1 score as a slim bar and a percentage, for a catalog row. */
export function Meter({ value, label }: { value: number; label: string }) {
  return (
    <HeroMeter
      aria-label={label}
      value={value}
      minValue={0}
      maxValue={1}
      size="sm"
      className="flex-row items-center gap-2"
    >
      <HeroMeter.Track className="min-w-12 flex-1">
        <HeroMeter.Fill />
      </HeroMeter.Track>
      <HeroMeter.Output className="text-muted font-mono text-xs tabular-nums" />
    </HeroMeter>
  );
}
