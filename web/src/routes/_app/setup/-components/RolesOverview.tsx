import { ArrowRight, ChevronRight } from "@gravity-ui/icons";
import { Chip, cn } from "@heroui/react";

import type { Found } from "../-lib/issues";
import { patchFor, type Propose } from "../-lib/patch";
import { accessLabel, type Role, ROLE_MEANING, ROLE_NAME } from "../-lib/roles";
import { modelName, parseRung } from "../-lib/rung";
import { ProviderIcon } from "../../../../components/provider-icon/ProviderIcon";
import { OnOff } from "./Section";

const SHOWN = 3;

/** A role's models as a chain, left to right in the order tried; the rest folded into a count. */
function Chain({ role }: { role: Role }) {
  if (role.hostSet) return <p className="text-muted text-[13px]">Picked by the app that runs catherd</p>;
  if (role.rungs.length === 0) return <p className="text-warning text-[13px]">No model yet</p>;
  const rest = role.rungs.length - SHOWN;
  return (
    <ol aria-label={`${role.role} models, in the order tried`} className="flex min-w-0 items-center gap-1.5">
      {role.rungs.slice(0, SHOWN).map(({ rung }, i) => {
        const r = parseRung(rung);
        return (
          <li key={rung} className={cn("flex shrink-0 items-center gap-1.5", i > 0 && "max-sm:hidden")}>
            {i > 0 ? <ArrowRight aria-hidden="true" className="text-muted size-3 shrink-0" /> : null}
            <span
              title={rung}
              className={cn(
                "flex h-7 min-w-0 items-center gap-1.5 rounded-sm border px-2",
                i === 0 ? "border-border bg-surface-secondary" : "border-border/60 text-muted",
              )}
            >
              <ProviderIcon backend={r.backend} size="xs" />
              <span className={cn("truncate text-[13px]", i === 0 && "text-foreground font-medium")}>
                {modelName(r.model)}
              </span>
              {r.effort ? <span className="text-muted shrink-0 text-[11px]">{r.effort}</span> : null}
            </span>
          </li>
        );
      })}
      {rest > 0 ? (
        <li className="text-muted shrink-0 text-xs tabular-nums max-sm:hidden">
          <ArrowRight aria-hidden="true" className="mr-1.5 inline size-3" />+{rest} more
        </li>
      ) : null}
      {role.rungs.length > 1 ? (
        <li className="text-muted shrink-0 text-xs tabular-nums sm:hidden">
          <ArrowRight aria-hidden="true" className="mr-1.5 inline size-3" />
          {role.rungs.length === 2 ? "1 fallback" : `${role.rungs.length - 1} fallbacks`}
        </li>
      ) : null}
    </ol>
  );
}

/** Every role on one line: what it does, the models it tries, its access, on or off. A line opens its editor. */
export function RolesOverview({
  roles,
  issuesOf,
  propose,
  disabled,
  onOpen,
}: {
  roles: Role[];
  issuesOf(role: string): Found[];
  propose: Propose;
  disabled: boolean;
  onOpen(role: string): void;
}) {
  return (
    <ul className="divide-border divide-y">
      {roles.map((role) => {
        const name = role.role;
        const lead = role.rungs[0] ? parseRung(role.rungs[0].rung).backend : name;
        const errors = issuesOf(name).filter((i) => i.error).length;
        return (
          <li
            key={name}
            aria-label={name}
            className="hover:bg-surface-secondary/50 relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 px-4 py-3 transition-colors lg:grid-cols-[19rem_minmax(0,1fr)_7rem_auto]"
          >
            <div className={cn("flex min-w-0 items-center gap-3", !role.enabled && "opacity-50")}>
              <ProviderIcon backend={lead} size="md" />
              <div className="flex min-w-0 flex-col">
                <button
                  type="button"
                  aria-label={`Edit ${name}`}
                  onClick={() => onOpen(name)}
                  className="focus-visible:after:outline-focus self-start text-left text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2"
                >
                  {ROLE_NAME[name]}
                </button>
                <span className="text-muted truncate text-xs">
                  {errors > 0 ? (
                    <span className="text-danger">{errors === 1 ? "1 problem" : `${errors} problems`} · </span>
                  ) : null}
                  {ROLE_MEANING[name]}
                </span>
              </div>
            </div>
            <div className="col-span-2 row-start-2 min-w-0 overflow-hidden lg:col-span-1 lg:col-start-2 lg:row-start-1">
              <div className={cn(!role.enabled && "opacity-50")}>
                <Chain role={role} />
              </div>
            </div>
            <div className="max-lg:hidden lg:col-start-3 lg:row-start-1">
              <Chip size="sm" variant="soft" color={role.access === "full" ? "warning" : "default"}>
                {accessLabel(role.access)}
              </Chip>
            </div>
            <div className="relative z-10 col-start-2 row-start-1 flex items-center gap-2 lg:col-start-4">
              <OnOff
                label={`${name} enabled`}
                isSelected={role.enabled}
                disabled={disabled}
                onChange={(enabled) => propose(patchFor("roles", { role: name, enabled }))}
              />
              <ChevronRight aria-hidden="true" className="text-muted pointer-events-none size-4" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
