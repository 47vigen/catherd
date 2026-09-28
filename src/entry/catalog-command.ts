import { defineCommand } from "citty";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { gitToplevel } from "../infra/git.ts";
import {
  type CatalogModel,
  catalogQuery,
  type Refreshed,
  refreshDiscovery,
  saveTreatLike,
} from "../services/catalog-service.ts";
import { readDerived } from "../infra/sources/cache.ts";
import { type SyncReport, syncSources } from "../services/source-sync.ts";
import { clearTreatLike, type LeftOnStandIn, resetTreatLikes, suggestFor } from "../services/treat-likes.ts";
import { exitCodeOf, JSON_ARG, mark, printError } from "./cli-kit.ts";

/**
 * Spec 1.2 §9: a sync, one line per source (fetched, fresh, skipped, or failed with the answer it kept),
 * then the rungs newly scored, the user's stand-ins no longer needed and the cross-check warnings.
 */
export function syncLines(r: SyncReport, plain = false): string[] {
  if (r.busy) return ["- sources: another sync is running; its results apply when it ends"];
  const out: string[] = [];
  for (const s of r.sources) {
    if (s.state === "fetched") out.push(`${mark("ok", plain)} ${s.source}: fetched`);
    else if (s.state === "fresh") out.push(`- ${s.source}: fresh (fetched ${s.fetchedAt})`);
    else if (s.state === "skipped") out.push(`- ${s.source}: ${s.detail}`);
    else
      out.push(
        `${mark("warn", plain)} ${s.source}: ${s.error}; ${s.fetchedAt ? `keeps the answer fetched ${s.fetchedAt}` : "no earlier answer"}`,
      );
  }
  if (r.newlyScored.length) out.push(`newly scored: ${r.newlyScored.join(", ")}`);
  for (const n of r.noLongerNeeded)
    out.push(`stand-in no longer needed: ${n.rung} has values of its own for what ${n.like} lent it`);
  for (const w of r.warnings) out.push(`${mark("warn", plain)} ${w}`);
  return out;
}

const sync = defineCommand({
  meta: {
    name: "sync",
    description:
      "Fetch the public model facts and scores now (each source at most every 12 hours unless --force) and show what changed",
  },
  args: {
    force: { type: "boolean", description: "fetch every source, however fresh" },
    unmatched: {
      type: "boolean",
      description: "also list each source's ids that match no model in the catalog",
    },
    ...JSON_ARG,
  },
  async run({ args }) {
    try {
      const r = await syncSources({ force: args.force === true });
      if (args.json) console.log(JSON.stringify(r, null, 2));
      else for (const l of syncLines(r)) console.log(l);
      if (args.unmatched && !args.json) {
        const unmatched = readDerived()?.unmatched ?? {};
        if (Object.keys(unmatched).length === 0) console.log("unmatched: none");
        for (const [source, ids] of Object.entries(unmatched))
          console.log(`unmatched in ${source}: ${ids.join(", ")}`);
      }
      const got = r.sources.some((s) => s.state === "fetched" || s.state === "fresh");
      process.exitCode = r.failed.length && !got ? 1 : 0;
    } catch (e) {
      fail(e);
    }
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

export function formatModel(m: CatalogModel): string {
  const scored = m.rungs.filter((r) => r.enabled).length;
  const listed = m.listed === false ? "  not offered by this account" : "";
  return `${m.backend}:${m.model}  ${scored}/${m.rungs.length} rungs scored  roles ${m.roles.join(",") || "none"}${listed}`;
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
  meta: { name: "list", description: "The models catherd can place, with their scored rungs" },
  args: {
    backend: { type: "string", description: "only this backend or billing key" },
    role: { type: "string", description: `only models for this role (${ROLES.join(", ")})` },
    text: { type: "string", description: "only ids containing this" },
    scored: { type: "boolean", description: "only models with a scored rung" },
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
        scoredOnly: args.scored === true,
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

/** Spec 1.2 §6.4: the profile rungs a removal leaves on an inferred stand-in, one line each. */
export function leftLines(left: LeftOnStandIn[], plain = false): string[] {
  return left.map(
    (l) =>
      `${mark("warn", plain)} ${l.profile}: ${l.rung} is left on an inferred stand-in for ${l.dims.join(", ")}`,
  );
}

/** Spec 1.2 §6.4 `--suggest`: the three nearest stand-ins, each with its distance and the features it rests on. */
export function suggestLines(r: ReturnType<typeof suggestFor>, rung: string): string[] {
  const head = r.lacking.length
    ? `${r.canonical} has no ${r.lacking.join(", ")} value of its own; the nearest stand-ins:`
    : `${r.canonical} has every value the bars use; the nearest scored rungs:`;
  if (r.suggestions.length === 0)
    return [
      `${r.canonical}: no scored rung shares 3 features with it; map it by hand: catherd catalog treat-like ${rung} <rung>`,
    ];
  return [
    head,
    ...r.suggestions.map(
      (s, i) =>
        `  ${i + 1}. ${s.like}  distance ${s.distance.toFixed(2)}  lends ${s.lends.join(", ")}  on ${s.features.join(", ")}`,
    ),
    `map one: catherd catalog treat-like ${rung} <rung>`,
  ];
}

const treatLike = defineCommand({
  meta: {
    name: "treat-like",
    description:
      "Score an unscored rung as a scored one; --suggest ranks stand-ins, --clear and --reset remove your mappings",
  },
  args: {
    rung: {
      type: "positional",
      required: false,
      description: "the unscored rung, backend:model#effort or model#effort",
    },
    like: { type: "positional", required: false, description: "the scored rung whose scores it borrows" },
    suggest: { type: "string", description: "list the 3 nearest stand-ins for this rung" },
    clear: { type: "string", description: "remove your treat-like for this rung" },
    reset: { type: "boolean", description: "remove every treat-like of yours" },
    ...JSON_ARG,
  },
  async run({ args }) {
    try {
      const modes = [
        args.suggest !== undefined,
        args.clear !== undefined,
        args.reset === true,
        args.rung !== undefined,
      ];
      if (modes.filter(Boolean).length !== 1 || (args.rung !== undefined && args.like === undefined))
        throw new CatherdError(
          "E_INPUT_INVALID",
          "treat-like takes <rung> <like>, or one of --suggest, --clear, --reset",
          {
            fix: "catherd catalog treat-like <rung> <like> | --suggest <rung> | --clear <rung> | --reset",
          },
        );
      if (args.suggest !== undefined) {
        const r = suggestFor(args.suggest);
        if (args.json) console.log(JSON.stringify(r, null, 2));
        else for (const l of suggestLines(r, args.suggest)) console.log(l);
        return;
      }
      if (args.clear !== undefined) {
        const r = await clearTreatLike(args.clear);
        if (args.json) return console.log(JSON.stringify(r, null, 2));
        for (const l of leftLines(r.left)) console.log(l);
        console.log(`${mark("ok")} ${r.rung} is no longer treated like ${r.like}`);
        return;
      }
      if (args.reset) {
        const r = await resetTreatLikes();
        if (args.json) return console.log(JSON.stringify(r, null, 2));
        for (const l of leftLines(r.left)) console.log(l);
        console.log(
          r.removed.length
            ? `${mark("ok")} removed ${r.removed.length} treat-like${r.removed.length === 1 ? "" : "s"}: ${r.removed.map(([a, b]) => `${a} → ${b}`).join(", ")}`
            : "no treat-like of yours to remove",
        );
        return;
      }
      const r = await saveTreatLike(args.rung as string, args.like as string);
      console.log(`✓ ${r.rung} is treated like ${r.like}`);
    } catch (e) {
      fail(e);
    }
  },
});

/** Spec §8 and 1.2 §9: `catherd catalog refresh|list|sync|treat-like <rung> <like> | --suggest|--clear|--reset`. */
export const catalogCommand = defineCommand({
  meta: { name: "catalog", description: "The model catalog" },
  subCommands: { refresh, list, sync, "treat-like": treatLike },
});
