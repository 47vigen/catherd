import { ArrowRotateRight } from "@gravity-ui/icons";
import { Button } from "@heroui/react";
import { useState } from "react";

import { parseRung } from "../-lib/rung";
import type { Check, SetupView } from "../../../../client";
import { CodeBlock } from "../../../../components/code-block/CodeBlock";
import { ProviderIcon } from "../../../../components/provider-icon/ProviderIcon";
import { StatusChip } from "../../../../components/status-chip/StatusChip";
import { formatRelative } from "../../../../lib/time";

const idOf = (c: Check) => c.id.replace(/^backend:/, "");

function CopyFix({ fix }: { fix: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <CodeBlock lang="text" code={fix} />
      <Button
        size="sm"
        variant="ghost"
        className="self-start"
        onPress={() => void navigator.clipboard?.writeText(fix).then(() => setCopied(true))}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function Card({ check, models }: { check: Check; models: number }) {
  const unready = check.state === "fail" || check.state === "warn";
  return (
    <li className="border-border bg-surface flex min-w-0 flex-col gap-3 rounded-sm border p-4">
      <div className="flex items-center gap-2.5">
        <ProviderIcon backend={idOf(check)} size="md" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{check.label}</span>
        <StatusChip status={check.state} label={check.word} />
      </div>
      <p className="text-muted text-xs">{check.detail}</p>
      <p className="text-muted text-xs tabular-nums">
        {models === 0 ? "No models offered" : `${models} ${models === 1 ? "model" : "models"} offered`}
      </p>
      {unready && check.fix ? <CopyFix fix={check.fix} /> : null}
    </li>
  );
}

/** The backends catherd can run: logo, version and login (the probe's detail), models offered, readiness. */
export function BackendCards({
  backends,
  roles,
  probedAt,
  isChecking,
  onRecheck,
}: {
  backends: Check[];
  roles: SetupView["roles"];
  probedAt: string | null;
  isChecking: boolean;
  onRecheck(): void;
}) {
  // The page keys this by `probedAt`, so a re-check starts a fresh "now".
  const [now] = useState(() => new Date());
  const modelsOf = (id: string) =>
    new Set(
      roles.flatMap((r) =>
        r.offered
          .map((p) => parseRung(p.rung))
          .filter((x) => x.backend === id)
          .map((x) => x.model),
      ),
    ).size;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-muted text-xs">
          {probedAt ? `Checked ${formatRelative(probedAt, now)}` : "Not checked yet"}
        </p>
        <Button size="sm" variant="secondary" isPending={isChecking} onPress={onRecheck}>
          <ArrowRotateRight aria-hidden="true" />
          Re-check
        </Button>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {backends.map((c) => (
          <Card key={c.id} check={c} models={modelsOf(idOf(c))} />
        ))}
      </ul>
    </div>
  );
}
