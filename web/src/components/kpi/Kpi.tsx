/** One headline figure with the single line that says what it tells you. */
export function Kpi({ label, value, meaning }: { label: string; value: string; meaning: string }) {
  return (
    <div className="border-border bg-surface flex min-w-0 flex-col gap-1 rounded-sm border px-4 py-3">
      <span className="label-caps text-muted">{label}</span>
      <span className="font-mono text-2xl leading-8 font-medium tracking-tight tabular-nums">{value}</span>
      <span className="text-muted text-xs leading-4">{meaning}</span>
    </div>
  );
}
