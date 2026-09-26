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
import { exitCodeOf, printError } from "./cli-kit.ts";

export function formatRefreshed(r: Refreshed): string {
  return r.error
    ? `! ${r.backend}: ${r.error}${r.fetchedAt ? ` (last listed ${r.fetchedAt})` : ""}`
    : `✓ ${r.backend}: ${r.models} models`;
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
  args: { json: { type: "boolean", description: "print JSON" } },
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
    json: { type: "boolean", description: "print JSON" },
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

const treatLike = defineCommand({
  meta: { name: "treat-like", description: "Score an unscored rung as a scored one" },
  args: {
    rung: {
      type: "positional",
      required: true,
      description: "the unscored rung, backend:model#effort or model#effort",
    },
    like: { type: "positional", required: true, description: "the scored rung whose scores it borrows" },
  },
  async run({ args }) {
    try {
      const r = await saveTreatLike(args.rung, args.like);
      console.log(`✓ ${r.rung} is treated like ${r.like}`);
    } catch (e) {
      fail(e);
    }
  },
});

/** Spec §8: `catherd catalog refresh|list|treat-like <rung> <like>`. */
export const catalogCommand = defineCommand({
  meta: { name: "catalog", description: "The model catalog" },
  subCommands: { refresh, list, "treat-like": treatLike },
});
