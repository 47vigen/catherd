import type { Issue } from "../../../../client";

export const SECTIONS = [
  "budget",
  "timeouts",
  "failover",
  "effort",
  "limits",
  "preflight",
  "land",
  "notifications",
  "billing",
  "isolation",
  "roles",
  "profiles",
] as const;
export type SectionId = (typeof SECTIONS)[number];

const FIELD_HOME: Record<string, SectionId> = {
  budget: "budget",
  timeouts: "timeouts",
  failover: "failover",
  maxEffort: "effort",
  lock: "limits",
  limits: "limits",
  preflight: "preflight",
  land: "land",
  notify: "notifications",
  billing: "billing",
  harness: "isolation",
  isolated: "isolation",
};

export type Home = SectionId | "access" | `role:${string}` | "other";

/** Where an issue shows: next to the field that causes it. Access warnings collapse into one line. */
export function homeOf(path: string): Home {
  const [field, role, leaf] = path.split(".");
  if (field === "roles" && role) return leaf === "access" ? "access" : `role:${role}`;
  return (field && FIELD_HOME[field]) || "other";
}

export type Found = Issue & { error: boolean };

/** Only warnings collapse into the access line; an access error stays with its role. */
const placeOf = (i: Found): Home => {
  const home = homeOf(i.path);
  return home === "access" && i.error ? `role:${i.path.split(".")[1]}` : home;
};

export const issuesAt = (issues: Found[], home: Home) => issues.filter((i) => placeOf(i) === home);
