import { billingKeyOf, type Catalog, rungInfo } from "../../domain/catalog.ts";
import { tryParseRung } from "../../domain/ids.ts";
import { NOTIFY, type NotifyMoment, type Profile } from "../../domain/profile.ts";
import { type Issue, inferredScores, routingProfileOf, type Validation } from "../../domain/profile-rules.ts";
import type { Access } from "../../domain/record.ts";
import { ROLES, type Role } from "../../domain/roles.ts";
import { candidates } from "../../domain/select.ts";
import type { CatalogModel } from "../../services/catalog-service.ts";
import type { NumberPath } from "./state.ts";
import { shortRung } from "./text.ts";

export type RowAction =
  | { type: "section" }
  | { type: "role"; role: Role }
  | { type: "access"; role: Role }
  | { type: "start"; role: Role }
  | { type: "group" }
  | { type: "model" }
  | { type: "rung"; role: Role; rung: string; scored: boolean }
  | { type: "objective" }
  | { type: "jev" }
  | { type: "isolated"; harness: string }
  | { type: "number"; path: NumberPath }
  | { type: "failover"; rung: string }
  | { type: "notify"; moment: NotifyMoment };

/** One line of the Profiles tree (spec §9.1: roles → access + backend → model → efforts, then settings). */
export interface Row {
  key: string;
  parent: string | null;
  depth: number;
  label: string;
  value: string;
  /** a checkbox's state; null for a row that is not one */
  check: boolean | null;
  expandable: boolean;
  expanded: boolean;
  /** headings are skipped by the cursor */
  selectable: boolean;
  /** drawn muted: an unusable rung, the children of a role that is off */
  dim: boolean;
  issue: (Issue & { level: "error" | "warning" }) | null;
  action: RowAction;
  /** what the filter matches: the labels of the row's parents, its own label and its value */
  search: string;
}

export interface TreeInput {
  /** the draft, resolved */
  profile: Profile;
  models: CatalogModel[];
  /** the catalog with the draft's staged treat-likes merged in (`withStaged`) */
  catalog: Catalog;
  staged: Record<string, string>;
  expanded: ReadonlySet<string>;
  /** the harnesses catherd can isolate: the registered adapters */
  harnesses: readonly string[];
  enforcement: (rung: string, access: Access) => "enforced" | "advisory";
  validation: Validation;
  /** every expandable row open, for filtering */
  expandAll?: boolean;
}

/** The catalog as it will be once the staged treat-likes are saved. */
export function withStaged(c: Catalog, staged: Record<string, string>): Catalog {
  if (Object.keys(staged).length === 0) return c;
  const treatLike = { ...c.treatLike };
  for (const [rung, like] of Object.entries(staged)) {
    try {
      treatLike[rungInfo(c, rung).canonical] = { like, source: "user" };
    } catch {
      // a staged rung that does not parse is never offered
    }
  }
  return { ...c, treatLike };
}

const GROUP_ORDER = [
  "claude",
  "claude-code",
  "codex",
  "opencode-go",
  "opencode",
  "cursor",
  "grok",
  "antigravity",
];
const GROUP_NOTE: Record<string, string> = { claude: "native subagent", "claude-code": "headless" };

interface ModelEntry {
  backend: string;
  model: string;
  key: string;
  efforts: string[];
  listed: boolean | null;
  /** efforts catalog_query scores (their own or through a saved treat-like) */
  scored: Set<string>;
  inferred: Set<string>;
}

function issueFor(v: Validation, match: (path: string) => boolean): Row["issue"] {
  const e = v.errors.find((i) => match(i.path));
  if (e) return { ...e, level: "error" };
  const w = v.warnings.find((i) => match(i.path));
  return w ? { ...w, level: "warning" } : null;
}

/** A role's models: those catalog_query says can fill it, plus any rung the profile holds that it lacks. */
function modelsFor(models: CatalogModel[], role: Role, rungs: string[]): ModelEntry[] {
  const out: ModelEntry[] = [];
  const find = (backend: string, model: string) =>
    out.find((m) => m.backend === backend && m.model === model);
  for (const m of models) {
    if (!m.roles.includes(role)) continue;
    const scored = new Set<string>();
    const inferred = new Set<string>();
    for (const r of m.rungs) {
      const effort = r.rung.slice(r.rung.lastIndexOf("#") + 1);
      if (r.enabled) scored.add(effort);
      if (r.treatLike || Object.values(r.scores).some((s) => s.confidence === "inferred"))
        inferred.add(effort);
    }
    out.push({
      backend: m.backend,
      model: m.model,
      key: m.billing,
      efforts: m.efforts.length ? [...m.efforts] : ["default"],
      listed: m.listed,
      scored,
      inferred,
    });
  }
  for (const rung of rungs) {
    const r = tryParseRung(rung);
    if (!r) continue;
    const m = find(r.backend, r.model);
    if (m) {
      if (!m.efforts.includes(r.effort)) m.efforts.push(r.effort);
      continue;
    }
    out.push({
      backend: r.backend,
      model: r.model,
      key: billingKeyOf(r),
      efforts: [r.effort],
      listed: null,
      scored: new Set(),
      inferred: new Set(),
    });
  }
  return out;
}

const rungOf = (m: ModelEntry, effort: string) => `${m.backend}:${m.model}#${effort}`;

/** The ladder routing would climb, cheapest first, as short rungs. */
function ladderOf(i: TreeInput, role: Role): string {
  const rc = i.profile.roles[role];
  if (!rc.enabled) return "off";
  const ladder = candidates(i.catalog, routingProfileOf(i.profile, role), role).map((c) => shortRung(c.rung));
  return ladder.length ? ladder.join(" → ") : "no usable rung";
}

/** Spec §9.1's Profiles tree for the draft: one row per line, in order. */
export function buildRows(i: TreeInput): Row[] {
  const rows: Row[] = [];
  const labels = new Map<string, string>();
  const open = (key: string) => i.expandAll === true || i.expanded.has(key);
  const add = (
    r: Omit<Row, "search" | "dim" | "issue" | "expandable" | "expanded" | "selectable" | "check"> &
      Partial<Pick<Row, "dim" | "issue" | "expandable" | "selectable" | "check">>,
  ) => {
    const path = `${r.parent ? (labels.get(r.parent) ?? "") : ""} ${r.label}`;
    labels.set(r.key, path);
    const row: Row = {
      check: null,
      dim: false,
      issue: null,
      expandable: false,
      selectable: true,
      ...r,
      expanded: r.expandable === true && open(r.key),
      search: `${path} ${r.value}`.toLowerCase(),
    };
    rows.push(row);
    return row;
  };
  const section = (key: string, label: string) =>
    add({ key, parent: null, depth: 0, label, value: "", selectable: false, action: { type: "section" } });

  section("section:roles", "ROLES");
  for (const role of ROLES) {
    const rc = i.profile.roles[role];
    const roleKey = `role:${role}`;
    const roleRow = add({
      key: roleKey,
      parent: "section:roles",
      depth: 1,
      label: role,
      value: ladderOf(i, role),
      check: rc.enabled,
      expandable: true,
      issue: issueFor(
        i.validation,
        (p) =>
          p === `roles.${role}.enabled` || p === `roles.${role}.rungs` || p === `roles.${role}.defaultRung`,
      ),
      action: { type: "role", role },
    });
    if (!roleRow.expanded) continue;
    const dim = !rc.enabled;
    const weakest = rc.rungs.some((r) => i.enforcement(r, rc.access) === "advisory")
      ? "advisory"
      : "enforced";
    add({
      key: `access:${role}`,
      parent: roleKey,
      depth: 2,
      label: "access",
      value: `${rc.access} · ${rc.rungs.length ? weakest : "no rung"}`,
      dim,
      issue: issueFor(i.validation, (p) => p === `roles.${role}.access`),
      action: { type: "access", role },
    });
    add({
      key: `start:${role}`,
      parent: roleKey,
      depth: 2,
      label: "default rung",
      value: rc.defaultRung ? shortRung(rc.defaultRung) : "the cheapest that clears the bar",
      dim,
      action: { type: "start", role },
    });
    const entries = modelsFor(i.models, role, rc.rungs);
    const keys = [...new Set(entries.map((m) => m.key))].sort(
      (a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b) || a.localeCompare(b),
    );
    for (const key of keys) {
      const groupKey = `group:${role}:${key}`;
      const note = GROUP_NOTE[key];
      add({
        key: groupKey,
        parent: roleKey,
        depth: 2,
        label: note ? `${key} (${note})` : key,
        value: i.profile.billing[key] ?? "",
        selectable: false,
        dim: true,
        action: { type: "group" },
      });
      for (const m of entries.filter((e) => e.key === key)) {
        const modelKey = `model:${role}:${m.backend}:${m.model}`;
        const ticked = m.efforts.filter((e) => rc.rungs.includes(rungOf(m, e))).length;
        const usable = m.efforts.some((e) => m.scored.has(e) || i.staged[rungOf(m, e)]);
        const flags = [m.listed === false ? "not listed" : "", usable ? "" : "unscored"].filter(Boolean);
        const modelRow = add({
          key: modelKey,
          parent: groupKey,
          depth: 3,
          label: m.model,
          value: [`${ticked} of ${m.efforts.length}`, ...flags].join(" · "),
          expandable: true,
          dim: dim || !usable,
          action: { type: "model" },
        });
        if (!modelRow.expanded) continue;
        for (const effort of m.efforts) {
          const rung = rungOf(m, effort);
          const staged = i.staged[rung];
          const scored = m.scored.has(effort) || staged !== undefined;
          const value = staged
            ? `treated like ${staged} · unsaved`
            : !scored
              ? "unscored · enter: treat like"
              : m.inferred.has(effort)
                ? "inferred"
                : "";
          add({
            key: `rung:${role}:${rung}`,
            parent: modelKey,
            depth: 4,
            label: effort,
            value,
            check: rc.rungs.includes(rung),
            dim: dim || !scored,
            action: { type: "rung", role, rung, scored },
          });
        }
      }
    }
  }

  section("section:routing", "ROUTING");
  add({
    key: "objective",
    parent: "section:routing",
    depth: 1,
    label: "objective",
    value: i.profile.objective,
    action: { type: "objective" },
  });
  add({
    key: "jev",
    parent: "section:routing",
    depth: 1,
    label: "Jev",
    value: i.profile.jev.use,
    action: { type: "jev" },
  });

  section("section:harness", "HARNESS");
  for (const h of i.harnesses) {
    const isolated = i.profile.harness[h]?.isolated ?? false;
    add({
      key: `harness:${h}`,
      parent: "section:harness",
      depth: 1,
      label: h,
      value: isolated ? "isolated" : "your own config",
      check: isolated,
      action: { type: "isolated", harness: h },
    });
  }

  section("section:budget", "BUDGET");
  const b = i.profile.budget;
  for (const [path, label, v] of [
    ["budget.minutes", "minutes", b.minutes],
    ["budget.tokens", "tokens", b.tokens],
    ["budget.usd", "usd", b.usd],
  ] as const)
    add({
      key: path,
      parent: "section:budget",
      depth: 1,
      label,
      value: v === undefined ? "no cap" : String(v),
      action: { type: "number", path },
    });

  section("section:failover", "FAILOVER");
  const onLadders = ROLES.filter((r) => i.profile.roles[r].enabled).flatMap((r) => i.profile.roles[r].rungs);
  const fromRungs = [
    ...new Set([...onLadders.filter((r) => !r.startsWith("claude:")), ...Object.keys(i.profile.failover)]),
  ].sort();
  if (fromRungs.length === 0)
    add({
      key: "failover:none",
      parent: "section:failover",
      depth: 1,
      label: "no rung to stand in for",
      value: "",
      selectable: false,
      dim: true,
      action: { type: "section" },
    });
  for (const rung of fromRungs) {
    const to = i.profile.failover[rung];
    let mark = "";
    if (to) {
      try {
        const note = inferredScores(i.catalog, rungInfo(i.catalog, to)).note;
        mark = note ? ` (${note})` : "";
      } catch {
        mark = "";
      }
    }
    add({
      key: `failover:${rung}`,
      parent: "section:failover",
      depth: 1,
      label: shortRung(rung),
      value: to ? `→ ${shortRung(to)}${mark}` : "none",
      issue: issueFor(i.validation, (p) => p === `failover.${rung}`),
      action: { type: "failover", rung },
    });
  }

  section("section:timeouts", "TIMEOUTS");
  add({
    key: "timeouts.idleMin",
    parent: "section:timeouts",
    depth: 1,
    label: "idle minutes",
    value: String(i.profile.timeouts.idleMin),
    action: { type: "number", path: "timeouts.idleMin" },
  });
  add({
    key: "timeouts.wallMin",
    parent: "section:timeouts",
    depth: 1,
    label: "wall minutes",
    value: String(i.profile.timeouts.wallMin),
    action: { type: "number", path: "timeouts.wallMin" },
  });

  section("section:notify", "NOTIFY");
  for (const moment of NOTIFY)
    add({
      key: `notify:${moment}`,
      parent: "section:notify",
      depth: 1,
      label: moment,
      value: "",
      check: i.profile.notify.includes(moment),
      action: { type: "notify", moment },
    });
  return rows;
}

/** Rows matching every word of `text`, with their parents so each keeps its place in the tree. */
export function filterRows(rows: Row[], text: string): Row[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  const keep = new Set<string>();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const r of rows)
    if (r.selectable && words.every((w) => r.search.includes(w)))
      for (let k: string | null = r.key; k && !keep.has(k); k = byKey.get(k)?.parent ?? null) keep.add(k);
  return rows.filter((r) => keep.has(r.key));
}

/** The first row the filter matches itself (not only as a parent of a match): where the cursor goes. */
export function firstMatch(rows: Row[], text: string): Row | null {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return (
    rows.find((r) => r.selectable && words.length > 0 && words.every((w) => r.search.includes(w))) ?? null
  );
}
