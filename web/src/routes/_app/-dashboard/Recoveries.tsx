import { Term } from "../../../components/term/Term";
import { Tile } from "../../../components/tile/Tile";

function Figure({ term, label, value, says }: { term: "failover"; label: string; value: number; says: string }) {
  return (
    <div className="bg-surface flex items-center justify-between gap-4 p-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <dt className="label-caps text-muted">
          <Term name={term}>{label}</Term>
        </dt>
        <dd className="text-muted text-xs leading-4">{says}</dd>
      </div>
      <dd
        className={`text-[28px] leading-none font-medium tracking-[-0.03em] tabular-nums ${value === 0 ? "text-muted" : ""}`}
      >
        {value}
      </dd>
    </div>
  );
}

/** How often a run had to recover on its own: a stand-in model after a limit. */
export function Recoveries({ failovers, className }: { failovers: number; className?: string }) {
  return (
    <Tile title="Recoveries" className={className}>
      <dl className="bg-border grid flex-1 auto-rows-fr gap-px">
        <Figure
          term="failover"
          label="Failovers"
          value={failovers}
          says="A provider limit hit, so a stand-in model ran."
        />
      </dl>
    </Tile>
  );
}
