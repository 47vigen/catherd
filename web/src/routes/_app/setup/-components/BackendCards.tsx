import { ArrowRotateRight } from "@gravity-ui/icons";
import { Button } from "@heroui/react";
import { useState } from "react";

import type { Check } from "../../../../client";
import { ProviderIcon, backendName } from "../../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../../components/status-chip/StatusChip";
import { Tile } from "../../../../components/tile/Tile";
import { formatRelative } from "../../../../lib/time";

const idOf = (c: Check) => c.id.replace(/^(backend|name):/, "");

function CopyFix({ fix }: { fix: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <code className="bg-surface-secondary min-w-0 flex-1 truncate rounded-sm px-2 py-1 font-mono text-xs" title={fix}>
        {fix}
      </code>
      <Button
        size="sm"
        variant="ghost"
        onPress={() => void navigator.clipboard?.writeText(fix).then(() => setCopied(true))}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function Row({ check }: { check: Check }) {
  const unready = check.state === "fail" || check.state === "warn";
  const name = check.id.startsWith("backend:") ? backendName(idOf(check)) : check.label;
  return (
    <li className="flex min-w-0 flex-col gap-2 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <ProviderIcon backend={idOf(check)} size="md" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="text-muted truncate text-xs" title={check.detail}>
            {check.detail}
          </span>
        </div>
        <span className="flex w-20 shrink-0 justify-end">
          <StatusChip status={check.state} label={check.word} />
        </span>
      </div>
      {unready && check.fix ? (
        <div className="pl-9">
          <CopyFix fix={check.fix} />
        </div>
      ) : null}
    </li>
  );
}

/** The backends catherd can run, one cell each: mark, readiness, version and login, models offered, and a fix. */
export function BackendCards({
  backends,
  probedAt,
  isChecking,
  onRecheck,
  className,
}: {
  backends: Check[];
  probedAt: string | null;
  isChecking: boolean;
  onRecheck(): void;
  className?: string;
}) {
  // The page keys this by `probedAt`, so a re-check starts a fresh "now".
  const [now] = useState(() => new Date());
  return (
    <Tile
      title="Backends"
      className={className}
      aside={
        <span className="flex items-center gap-2">
          <span className="text-muted text-xs">
            {probedAt ? `Checked ${formatRelative(probedAt, now)}` : "Not checked yet"}
          </span>
          <Button size="sm" variant="ghost" isPending={isChecking} onPress={onRecheck}>
            <ArrowRotateRight aria-hidden="true" />
            Re-check
          </Button>
        </span>
      }
    >
      <ul className="divide-border divide-y">
        {backends.map((c) => (
          <Row key={c.id} check={c} />
        ))}
      </ul>
    </Tile>
  );
}
