import type { FlowCheck } from "../../../../../client";

/** Evidence only: the recorded log path is never treated as a fetch target. */
export function FlowCheckDetails({ check }: { check: FlowCheck }) {
  const rows = [
    ["Scope", check.scope],
    ["Base", check.base ? "Yes" : "No"],
    ["Command", check.command],
    ["Requested", check.startedAt ?? "Timing unknown"],
    ["Ended", check.endedAt ?? "Running"],
    ["Exit", check.endedAt ? String(check.exit ?? "Unknown") : "Pending"],
    ["Failures", String(check.failureCount ?? "Unknown")],
    ["Verdict", check.verdict ?? "Unknown"],
    ["Cached", check.cached ? "Yes" : "No"],
    ["Log path", check.logPath ?? "Unavailable"],
  ];
  return (
    <section aria-label="Check details" className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="font-mono text-xs break-words whitespace-pre-wrap">{value}</dd>
          </div>
        ))}
      </dl>
      {check.newFailures === null || check.inheritedFailures === null ? (
        <p className="text-muted text-sm">Failure split unavailable</p>
      ) : (
        <p className="text-sm">
          {check.newFailures} new failures · {check.inheritedFailures} inherited failures
        </p>
      )}
      {check.why ? <p className="text-sm whitespace-pre-wrap">{check.why}</p> : null}
      {check.failures.length ? (
        <div>
          <h3 className="label-caps text-danger">Failures</h3>
          <ul className="mt-2 list-inside list-disc text-sm">
            {check.failures.map((f, i) => (
              <li key={i} className="break-words whitespace-pre-wrap">
                {f}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {check.preExisting.length ? (
        <div>
          <h3 className="label-caps text-muted">Pre-existing failures</h3>
          <ul className="mt-2 list-inside list-disc text-sm">
            {check.preExisting.map((f, i) => (
              <li key={i} className="break-words whitespace-pre-wrap">
                {f}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
