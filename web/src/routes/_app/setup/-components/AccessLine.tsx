import { Disclosure, Button } from "@heroui/react";

import type { Found } from "../-lib/issues";

/** The warnings about a role's access level, collapsed to one line that opens into the list. */
export function AccessLine({ warnings }: { warnings: Found[] }) {
  if (warnings.length === 0) return null;
  const n = warnings.length;
  return (
    <Disclosure className="border-border bg-surface rounded-sm border px-3 py-1.5">
      <Disclosure.Heading className="flex flex-wrap items-center justify-between gap-x-3">
        <span className="text-warning text-[13px]">
          {n === 1
            ? "1 role runs with full access, wider than catherd's default."
            : `${n} roles run with full access, wider than catherd's default.`}
        </span>
        <Button slot="trigger" size="sm" variant="ghost">
          Why it matters
          <Disclosure.Indicator />
        </Button>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="flex flex-col gap-1 pb-2">
          {warnings.map((w, i) => (
            <p key={i} className="text-muted text-xs">
              {w.path}: {w.message}
              {w.fix ? ` (${w.fix})` : ""}
            </p>
          ))}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
