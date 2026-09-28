import { type Catalog, rungInfo, scoresOf } from "../../domain/catalog.ts";
import { parseRung, tryParseRung } from "../../domain/ids.ts";
import { NOTIFY, type Profile, type ProfilePatch } from "../../domain/profile.ts";
import { inferredScores, quotaOf } from "../../domain/profile-rules.ts";
import { ACCESS } from "../../domain/record.ts";
import type { Role } from "../../domain/roles.ts";
import type { CatalogModel } from "../../services/catalog-service.ts";
import type { RowAction } from "./profile-tree.ts";
import type { NumberPath, SelectOption } from "./state.ts";
import { shortRung } from "./text.ts";

// What the Profiles tab's rows change: the patch a toggle or cycle makes, number fields, and the options
// each picker dialog offers. profile-tree.ts builds the rows themselves.

const next = <T>(list: readonly T[], cur: T): T => list[(list.indexOf(cur) + 1) % list.length] as T;

/**
 * The patch a toggle (space) or a cycle (enter) makes on the draft; null for rows that open a dialog
 * or expand instead. Space on a model row never changes a rung (research K5).
 */
export function patchFor(p: Profile, a: RowAction): ProfilePatch | null {
  switch (a.type) {
    case "role":
      return { roles: { [a.role]: { enabled: !p.roles[a.role].enabled } } };
    case "access":
      return { roles: { [a.role]: { access: next(ACCESS, p.roles[a.role].access) } } };
    case "rung": {
      const rc = p.roles[a.role];
      if (!rc.rungs.includes(a.rung)) return { roles: { [a.role]: { rungs: [...rc.rungs, a.rung] } } };
      return {
        roles: {
          [a.role]: {
            rungs: rc.rungs.filter((r) => r !== a.rung),
            ...(rc.defaultRung === a.rung ? { defaultRung: null } : {}),
          },
        },
      };
    }
    case "objective":
      return { objective: p.objective === "cost" ? "speed" : "cost" };
    case "jev":
      return { jev: { use: p.jev.use === "auto" ? "off" : "auto" } };
    case "isolated":
      return { harness: { [a.harness]: { isolated: !(p.harness[a.harness]?.isolated ?? false) } } };
    case "notify":
      return {
        notify: p.notify.includes(a.moment)
          ? p.notify.filter((m) => m !== a.moment)
          : NOTIFY.filter((m) => m === a.moment || p.notify.includes(m)),
      };
    default:
      return null;
  }
}

/** A number field set, or cleared with null (a budget cap); timeouts cannot be cleared. */
export function numberPatch(path: NumberPath, value: number | null): ProfilePatch {
  const [head, leaf] = path.split(".") as ["budget" | "timeouts", string];
  return { [head]: { [leaf]: value } } as ProfilePatch;
}

/** Parses a value editor's text: a positive number, or empty for no cap where the field allows one. */
export function parseNumber(path: NumberPath, text: string): { value: number | null } | { error: string } {
  const t = text.trim();
  if (t === "")
    return path.startsWith("budget.") ? { value: null } : { error: "enter a number of minutes above 0" };
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return { error: `"${t}" is not a number above 0` };
  if (path === "budget.tokens" && !Number.isInteger(n)) return { error: "tokens are a whole number" };
  return { value: n };
}

export function numberValue(p: Profile, path: NumberPath): number | undefined {
  const [head, leaf] = path.split(".") as ["budget" | "timeouts", string];
  return (p[head] as Record<string, number | undefined>)[leaf];
}

/** The default-rung picker: the role's rungs, and none. */
export function startOptions(p: Profile, role: Role): SelectOption[] {
  const rc = p.roles[role];
  return [
    {
      value: "",
      title: "none: the cheapest rung that clears the bar",
      current: rc.defaultRung === undefined,
    },
    ...rc.rungs.map((r) => ({ value: r, title: shortRung(r), detail: r, current: r === rc.defaultRung })),
  ];
}

/** The failover picker: every usable rung on another quota (Ruling 3 of plan 5), and none. */
export function failoverOptions(
  p: Profile,
  models: CatalogModel[],
  c: Catalog,
  rung: string,
): SelectOption[] {
  const parsed = tryParseRung(rung);
  if (!parsed) return [];
  const quota = quotaOf(parsed);
  const cur = p.failover[rung];
  const out: SelectOption[] = [{ value: "", title: "none", current: cur === undefined }];
  // usable: scored in catalog_query, or through a treat-like staged in `c` (`withStaged`)
  const usable = (x: string) => {
    try {
      return scoresOf(c, rungInfo(c, x).canonical) !== null;
    } catch {
      return false;
    }
  };
  for (const m of models)
    for (const r of m.rungs) {
      if (!(r.enabled || usable(r.rung)) || r.rung.startsWith("claude:")) continue;
      const q = quotaOf(parseRung(r.rung));
      if (q === quota) continue;
      const note = inferredScores(c, rungInfo(c, r.rung)).note;
      out.push({
        value: r.rung,
        title: shortRung(r.rung),
        group: m.billing,
        detail: note ?? "",
        current: r.rung === cur,
      });
    }
  return out;
}

/** The treat-like picker: every rung with scores of its own, by model. */
export function treatLikeOptions(c: Catalog): SelectOption[] {
  return Object.keys(c.scores)
    .filter((canonical) => scoresOf(c, canonical)?.via === null)
    .sort()
    .map((canonical) => ({
      value: canonical,
      title: canonical,
      group: canonical.slice(0, canonical.lastIndexOf("#")),
    }));
}
