import type { ReactNode } from "react";

import type { Overview } from "../../../client";
import { Blocks } from "../../../components/charts/Blocks";
import { backendName, ProviderIcon } from "../../../components/provider-icon/ProviderIcon";
import { Tile } from "../../../components/tile/Tile";
import { backendTone, formatCount, formatSecs, modelName } from "./format";

type Share = { id: string; mark?: ReactNode; name: string; sub?: string; value: number; tone?: string };

/** Rows of who took the most, largest first: a name, its share as blocks, and the figure on the right. */
function ShareList({ label, rows, format }: { label: string; rows: Share[]; format: (n: number) => string }) {
  if (rows.length === 0)
    return <p className="text-muted flex flex-1 items-center justify-center p-4 text-sm">Nothing in this range yet.</p>;
  const max = Math.max(...rows.map((r) => r.value), 0);
  return (
    <ul aria-label={label} className="flex flex-col gap-3.5 p-4">
      {rows.map((r) => (
        <li key={r.id} className="flex min-w-0 items-center gap-3">
          {r.mark}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <span
                className="min-w-0 truncate text-[13px] leading-4 font-medium"
                title={r.sub ? `${r.name} · ${r.sub}` : r.name}
              >
                {r.name}
                {r.sub ? <span className="text-muted font-normal"> · {r.sub}</span> : null}
              </span>
              <span className="text-muted shrink-0 font-mono text-xs tabular-nums">{format(r.value)}</span>
            </div>
            <Blocks value={r.value} max={max} tone={r.tone} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Tokens by model, each with its provider mark and the name people use for it. */
export function ModelShares({ models, className }: { models: Overview["tokensByModel"]; className?: string }) {
  const rows = models.map((m) => {
    const known = m.model.includes(":");
    return {
      id: m.model,
      mark: known ? (
        <ProviderIcon backend={m.model} size="sm" />
      ) : (
        <span aria-hidden="true" className="size-5 shrink-0" />
      ),
      name: modelName(m.model),
      sub: known ? backendName(m.model) : undefined,
      value: m.tokens,
      tone: known ? backendTone(m.model).bg : "bg-muted",
    };
  });
  return (
    <Tile title="Tokens by model" className={className}>
      {models.length > 0 ? (
        <p className="flex items-baseline gap-2 px-4 pt-4">
          <span className="text-xl leading-none font-medium tracking-[-0.02em] tabular-nums">
            {formatCount(models.reduce((n, m) => n + m.tokens, 0))}
          </span>
          <span className="text-muted text-xs">
            across {models.length} {models.length === 1 ? "model" : "models"}
          </span>
        </p>
      ) : null}
      <ShareList label="Tokens by model" rows={rows} format={formatCount} />
    </Tile>
  );
}

/** The role palette the run page and its flow chart use, so a colour means the same role everywhere. */
const ROLE_TONE: Record<string, string> = {
  architect: "bg-chart-4",
  worker: "bg-chart-1",
  writer: "bg-chart-1",
  artist: "bg-chart-1",
  reviewer: "bg-chart-2",
  verifier: "bg-chart-2",
  researcher: "bg-chart-3",
};

/** Worked time per role. */
export function RoleShares({ roles, className }: { roles: Overview["secsByRole"]; className?: string }) {
  const rows = roles.map((r) => ({
    id: r.role,
    mark: <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-[3px] ${ROLE_TONE[r.role] ?? "bg-muted"}`} />,
    name: r.role.charAt(0).toUpperCase() + r.role.slice(1),
    value: r.secs,
    tone: ROLE_TONE[r.role] ?? "bg-muted",
  }));
  return (
    <Tile title="Time by role" className={className}>
      <ShareList label="Time by role" rows={rows} format={formatSecs} />
    </Tile>
  );
}
