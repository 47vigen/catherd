import type { ProfilePatch, Settings } from "../../../../client";

/** Hands a patch to the page's one save path: preview, review, save. */
export type Propose = (patch: ProfilePatch) => void;

type Role = NonNullable<ProfilePatch["roles"]>[string];
type Effort = NonNullable<NonNullable<ProfilePatch["maxEffort"]>[string]>;
type Billing = Settings["billing"][string];

/** What each Setup section edits; `patchFor` turns it into the profile patch the server previews and saves. */
export interface SectionValues {
  objective: { objective: "cost" | "speed" };
  budget: { minutes: number | null; tokens: number | null; usd: number | null };
  timeouts: { idleMin: number; wallMin: number };
  /** `previous` is what the profile holds now: a pair missing from `pairs` is deleted. */
  failover: { pairs: Record<string, string>; previous: Record<string, string> };
  effort: { efforts: Record<string, Effort>; previous: Record<string, string> };
  bars: Record<string, number>;
  limits: {
    heavy: number | "cpus/2";
    reserveMb: number | null;
    perMilestoneMb: number | null;
    floorMb: number | null;
  };
  preflight: { confirm: boolean };
  notifications: { notify: Settings["notify"] };
  jev: { use: "auto" | "off" };
  billing: Record<string, Billing>;
  isolation: Record<string, boolean>;
  /** Only the fields given are sent; both timeouts cleared removes the role's own timeouts. */
  roles: {
    role: string;
    rungs?: string[];
    enabled?: boolean;
    access?: NonNullable<Role["access"]>;
    network?: boolean | null;
    timeouts?: { idleMin: number | null; wallMin: number | null };
  };
}

const removed = (now: Record<string, unknown>, previous: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(previous).flatMap((k) => (k in now ? [] : [[k, null]])));

/** The patch for one section. A cleared optional number is `null`, which deletes it (RFC 7396). */
export function patchFor<S extends keyof SectionValues>(section: S, values: SectionValues[S]): ProfilePatch {
  const v = values as SectionValues[keyof SectionValues];
  switch (section) {
    case "objective":
      return { objective: (v as SectionValues["objective"]).objective };
    case "budget":
      return { budget: { ...(v as SectionValues["budget"]) } };
    case "timeouts":
      return { timeouts: { ...(v as SectionValues["timeouts"]) } };
    case "failover": {
      const { pairs, previous } = v as SectionValues["failover"];
      return { failover: { ...removed(pairs, previous), ...pairs } };
    }
    case "effort": {
      const { efforts, previous } = v as SectionValues["effort"];
      return { maxEffort: { ...removed(efforts, previous), ...efforts } };
    }
    case "bars":
      return { bars: { ...(v as SectionValues["bars"]) } };
    case "limits": {
      const { heavy, ...memory } = v as SectionValues["limits"];
      return { lock: { heavy }, limits: { memory } };
    }
    case "preflight":
      return {
        preflight: { confirm: (v as SectionValues["preflight"]).confirm },
      };
    case "notifications":
      return { notify: [...(v as SectionValues["notifications"]).notify] };
    case "jev":
      return { jev: { use: (v as SectionValues["jev"]).use } };
    case "billing":
      return { billing: { ...(v as SectionValues["billing"]) } };
    case "isolation":
      return {
        harness: Object.fromEntries(
          Object.entries(v as SectionValues["isolation"]).map(([k, isolated]) => [k, { isolated }]),
        ),
      };
    case "roles": {
      const { role, timeouts, ...rest } = v as SectionValues["roles"];
      const out: Role = { ...rest };
      if (timeouts) out.timeouts = timeouts.idleMin === null && timeouts.wallMin === null ? null : timeouts;
      return { roles: { [role]: out } };
    }
    default:
      throw new Error(`no patch for section ${String(section)}`);
  }
}

/** A number field's text: empty is `null` (clear it), a positive number is itself, anything else is `undefined`. */
export function parseAmount(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
