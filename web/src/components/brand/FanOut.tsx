import { cn } from "@heroui/react";

const LANES = 11;
const W = 560;
const H = 420;
const HUB = { x: 150, y: H / 2 };

/** One lane: a smooth curve from the hub out to its provider. */
function lane(i: number): string {
  const y = 34 + (i * (H - 68)) / (LANES - 1);
  return `M ${HUB.x} ${HUB.y} C ${HUB.x + 150} ${HUB.y}, ${W - 260} ${y}, ${W - 70} ${y}`;
}

/**
 * The picture of what catherd does: one session at a point, its work fanned out across every agent.
 * A few lanes carry a moving pulse; with reduced motion they stay still.
 */
export function FanOut({ className }: { className?: string }) {
  const lanes = Array.from({ length: LANES }, (_, i) => i);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className={cn("h-auto w-full", className)} fill="none">
      <path d={`M 0 ${HUB.y} L ${HUB.x} ${HUB.y}`} className="stroke-foreground/50" strokeWidth="1" />
      {lanes.map((i) => (
        <path key={i} id={`lane-${i}`} d={lane(i)} className="stroke-foreground/18" strokeWidth="1" />
      ))}
      {lanes.map((i) => {
        const y = 34 + (i * (H - 68)) / (LANES - 1);
        return (
          <g key={i}>
            <rect x={W - 70} y={y - 9} width="52" height="18" className="fill-surface stroke-foreground/25" />
            <rect
              x={W - 64}
              y={y - 2}
              width={i % 3 === 0 ? 28 : i % 3 === 1 ? 20 : 34}
              height="4"
              className={i === 2 || i === 7 ? "fill-accent" : "fill-foreground/20"}
            />
          </g>
        );
      })}
      {[2, 5, 7, 9].map((i, n) => (
        <circle key={i} r="2.5" className="fill-accent motion-reduce:hidden">
          <animateMotion dur={`${2.6 + n * 0.7}s`} begin={`${n * 0.6}s`} repeatCount="indefinite">
            <mpath href={`#lane-${i}`} />
          </animateMotion>
        </circle>
      ))}
      <rect x={HUB.x - 14} y={HUB.y - 14} width="28" height="28" className="fill-accent" />
      <rect x={HUB.x - 6} y={HUB.y + 1} width="12" height="5" className="fill-accent-foreground" />
      <rect x={HUB.x - 4} y={HUB.y - 6} width="6" height="3" className="fill-accent-foreground/60" />
    </svg>
  );
}
