import { defineCommand } from "citty";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { gitToplevel } from "../infra/git.ts";
import {
  type CatalogModel,
  catalogQuery,
  type IndexStatus,
  type Refreshed,
  refreshDiscovery,
  refreshIndex,
} from "../services/catalog-service.ts";
import { indexCheck } from "../services/doctor-checks.ts";
import { exitCodeOf, JSON_ARG, mark, printError } from "./cli-kit.ts";

/** `sync`'s one line: the index's pair count and age, or why the last fetch failed and what was kept. */
export function syncLine(s: IndexStatus, plain = false, now = Date.now()): string {
  const c = indexCheck(now, s);
  return `${mark(c.state === "ok" ? "ok" : "warn", plain)} ${c.label}: ${c.detail}`;
}

const sync = defineCommand({
  meta: {
    name: "sync",
    description:
      "Fetch the Slopalytics index now (it is refreshed at most hourly unless --force) and show how many pairs it holds",
  },
  args: {
    force: { type: "boolean", description: "fetch even when the index was checked within the hour" },
    ...JSON_ARG,
  },
  async run({ args }) {
    const s = await refreshIndex({ force: args.force === true });
    if (args.json) console.log(JSON.stringify(s, null, 2));
    else console.log(syncLine(s));
    process.exitCode = s.pairs === 0 ? 1 : 0;
  },
});

/** One backend's refresh: its model count, else why it listed none, then its fix on a line of its own. */
export function formatRefreshed(r: Refreshed, plain = false): string {
  if (!r.error) return `${mark("ok", plain)} ${r.backend}: ${r.models} models`;
  return [
    `${mark("warn", plain)} ${r.backend}: ${r.error}${r.fetchedAt ? ` (last listed ${r.fetchedAt})` : ""}`,
    ...(r.fix ? [`    fix: ${r.fix}`] : []),
  ].join("\n");
}

/** One model: its indexed pairs and roles, then each pair's intelligence, price, speed and the runs catherd has made on it. */
export function formatModel(m: CatalogModel): string {
  const listed = m.listed === false ? "  not offered by this account" : "";
  const newer = m.supersededBy ? `  newer: ${m.supersededBy}` : "";
  const lines = [
    `${m.backend}:${m.model}  ${m.rungs.length} ${m.rungs.length === 1 ? "pair" : "pairs"}  roles ${m.roles.join(",") || "none"}${listed}${newer}`,
  ];
  for (const r of m.rungs) {
    const parts = [
      `intelligence ${r.intelligence.toFixed(1)}`,
      ...(r.price ? [`$${r.price.input}/$${r.price.output} per M`] : []),
      ...(r.speed !== null ? [`${Number(r.speed.toPrecision(3))} tok/s`] : []),
    ];
    lines.push(`  #${r.rung.slice(r.rung.lastIndexOf("#") + 1)}  ${parts.join(" · ")}`);
    if (r.evidence) lines.push(`    runs: ${r.evidence}`);
  }
  return lines.join("\n");
}

/** The repository the command runs in, for per-repository listings; none outside one (global). */
const hereRepo = async (): Promise<string | undefined> => (await gitToplevel(process.cwd())) ?? undefined;

function fail(e: unknown): void {
  if (!isCatherdError(e)) throw e;
  printError(e);
  process.exitCode = exitCodeOf(e);
}

const refresh = defineCommand({
  meta: { name: "refresh", description: "List every backend's models now" },
  args: JSON_ARG,
  async run({ args }) {
    const r = await refreshDiscovery({ repo: await hereRepo() });
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else for (const x of r) console.log(formatRefreshed(x));
    process.exitCode = r.some((x) => !x.error) ? 0 : 1;
  },
});

const list = defineCommand({
  meta: { name: "list", description: "The models catherd can place, with their indexed pairs" },
  args: {
    backend: { type: "string", description: "only this backend or billing key" },
    role: { type: "string", description: `only models for this role (${ROLES.join(", ")})` },
    text: { type: "string", description: "only ids containing this" },
    older: { type: "boolean", description: "include models a newer version replaces" },
    ...JSON_ARG,
  },
  async run({ args }) {
    if (args.role && !(ROLES as readonly string[]).includes(args.role))
      return fail(
        new CatherdError("E_INPUT_INVALID", `no role "${args.role}"`, {
          fix: `pass --role ${ROLES.join("|")}`,
        }),
      );
    try {
      const r = catalogQuery({
        backend: args.backend,
        role: args.role as Role | undefined,
        text: args.text,
        older: args.older,
        limit: 10_000,
        repo: await hereRepo(),
      });
      if (args.json) console.log(JSON.stringify(r, null, 2));
      else for (const m of r.models) console.log(formatModel(m));
    } catch (e) {
      fail(e);
    }
  },
});

/** Spec §8: `catherd catalog refresh|list|sync`. */
export const catalogCommand = defineCommand({
  meta: { name: "catalog", description: "The model catalog" },
  subCommands: { refresh, list, sync },
});
