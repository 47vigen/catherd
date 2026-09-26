import { afterEach, describe, expect, it } from "bun:test";
import { defaultProfileDoc, type Profile, applyPatch, resolveProfile } from "../../../src/domain/profile.ts";
import { validateProfile } from "../../../src/domain/profile-rules.ts";
import type { CatalogModel } from "../../../src/services/catalog-service.ts";
import { catalogQuery, loadCatalog } from "../../../src/services/catalog-service.ts";
import {
  buildRows,
  failoverOptions,
  filterRows,
  numberPatch,
  parseNumber,
  patchFor,
  type Row,
  startOptions,
  type TreeInput,
  treatLikeOptions,
  withStaged,
} from "../../../src/entry/tui/profile-tree.ts";
import { snapshotEnv, withHome } from "../../helpers.ts";

afterEach(snapshotEnv());

const BACKENDS = ["claude", "codex", "claude-code", "opencode"];

/** A model a backend listed that catherd has no scores for (spec §5.2: listed, disabled until mapped). */
const GLM: CatalogModel = {
  id: "opencode-go/glm-6",
  name: null,
  backend: "opencode",
  model: "opencode-go/glm-6",
  billing: "opencode-go",
  efforts: [],
  context: null,
  capabilities: null,
  roles: ["worker", "reviewer"],
  listed: true,
  notes: {},
  rungs: [
    {
      rung: "opencode:opencode-go/glm-6#default",
      enabled: false,
      scores: {},
      treatLike: null,
      cost: { kind: "metered", value: 0 } as never,
    },
  ],
};

function input(o: Partial<TreeInput> & { profile?: Profile } = {}): TreeInput {
  withHome();
  const profile = o.profile ?? resolveProfile(defaultProfileDoc(), "default");
  const staged = o.staged ?? {};
  const catalog = withStaged(loadCatalog({ timings: false }), staged);
  return {
    profile,
    models: [...catalogQuery({ scoredOnly: false, limit: 1000 }, profile.billing).models, GLM],
    catalog,
    staged,
    expanded: new Set(),
    harnesses: ["codex", "claude-code", "opencode"],
    enforcement: (rung) => (rung.startsWith("codex:") ? "enforced" : "advisory"),
    validation: validateProfile(profile, catalog, BACKENDS),
    ...o,
  };
}

const row = (rows: Row[], key: string) => rows.find((r) => r.key === key) as Row;

describe("the Profiles tree (spec §9.1)", () => {
  it("lists the roles with their ladders, then the settings, collapsed", () => {
    const rows = buildRows(input());
    expect(rows.filter((r) => r.depth === 0).map((r) => r.label)).toEqual([
      "ROLES",
      "ROUTING",
      "HARNESS",
      "BUDGET",
      "FAILOVER",
      "TIMEOUTS",
      "NOTIFY",
    ]);
    expect(row(rows, "role:worker")).toMatchObject({
      check: true,
      expandable: true,
      expanded: false,
      value: "gpt-6-luna#high → gpt-6-sol#medium → gpt-6-sol#high → gpt-6-sol#xhigh",
      issue: null,
    });
    expect(rows.some((r) => r.key.startsWith("model:"))).toBe(false);
    expect(row(rows, "section:roles").selectable).toBe(false);
    expect(row(rows, "budget.usd").value).toBe("no cap");
    expect(row(rows, "notify:finish").check).toBe(true);
  });

  it("opens a role into its access with enforcement, its default rung, and backend → model → efforts", () => {
    const rows = buildRows(input({ expanded: new Set(["role:worker", "model:worker:codex:gpt-6-sol"]) }));
    expect(row(rows, "access:worker").value).toBe("workspace-write · enforced");
    expect(row(rows, "start:worker").value).toBe("gpt-6-sol#medium");
    expect(row(rows, "group:worker:codex")).toMatchObject({ value: "chatgpt-plan", selectable: false });
    expect(row(rows, "model:worker:codex:gpt-6-sol").value).toBe("3 of 6");
    const efforts = rows.filter((r) => r.parent === "model:worker:codex:gpt-6-sol");
    expect(efforts.map((r) => [r.label, r.check])).toEqual([
      ["low", false],
      ["medium", true],
      ["high", true],
      ["xhigh", true],
      ["max", false],
      ["ultra", false],
    ]);
    expect(row(rows, "rung:worker:codex:gpt-6-sol#ultra")).toMatchObject({
      value: "unscored · enter: treat like",
      dim: true,
    });
  });

  it("marks an unscored model, and shows a staged treat-like as usable and unsaved", () => {
    const open = new Set(["role:worker", "model:worker:opencode:opencode-go/glm-6"]);
    const before = buildRows(input({ expanded: open }));
    expect(row(before, "model:worker:opencode:opencode-go/glm-6").value).toBe("0 of 1 · unscored");
    const staged = { "opencode:opencode-go/glm-6#default": "gpt-6-sol#medium" };
    const after = buildRows(input({ expanded: open, staged }));
    expect(row(after, "rung:worker:opencode:opencode-go/glm-6#default")).toMatchObject({
      value: "treated like gpt-6-sol#medium · unsaved",
      dim: false,
      action: { type: "rung", scored: true },
    });
  });

  it("marks both default stand-ins inferred, as plan 5 Ruling 2 says (spec §7.2)", () => {
    const rows = buildRows(input());
    expect(row(rows, "failover:codex:gpt-6-sol#high").value).toBe("→ kimi-k3#max (inferred)");
    expect(row(rows, "failover:codex:gpt-6-luna#high").value).toBe("→ gpt-6-luna#high (inferred)");
  });

  it("puts a validation issue on the row it is about", () => {
    const profile = resolveProfile(
      applyPatch(defaultProfileDoc(), { roles: { worker: { enabled: false } } }),
      "x",
    );
    const rows = buildRows(input({ profile }));
    expect(row(rows, "role:worker")).toMatchObject({ value: "off", issue: { level: "error" } });
  });

  it("filters to matching rows and keeps their parents", () => {
    const rows = buildRows(input({ expandAll: true }));
    const kept = filterRows(rows, "worker xhigh");
    expect(kept.map((r) => r.key)).toContain("rung:worker:codex:gpt-6-sol#xhigh");
    expect(kept.map((r) => r.key)).toContain("model:worker:codex:gpt-6-sol");
    expect(kept.map((r) => r.key)).toContain("section:roles");
    expect(kept.some((r) => r.key.startsWith("role:") && r.key !== "role:worker")).toBe(false);
    expect(filterRows(rows, "  ")).toBe(rows);
  });
});

describe("edits", () => {
  const p = resolveProfile(defaultProfileDoc(), "default");

  it("toggles a role and cycles its access", () => {
    expect(patchFor(p, { type: "role", role: "writer" })).toEqual({ roles: { writer: { enabled: false } } });
    expect(patchFor(p, { type: "access", role: "worker" })).toEqual({
      roles: { worker: { access: "full" } },
    });
    expect(patchFor(p, { type: "access", role: "verifier" })).toEqual({
      roles: { verifier: { access: "read-only" } },
    });
  });

  it("adds a rung, and removing the default rung clears it", () => {
    expect(patchFor(p, { type: "rung", role: "worker", rung: "codex:gpt-6-sol#max", scored: true })).toEqual({
      roles: { worker: { rungs: [...p.roles.worker.rungs, "codex:gpt-6-sol#max"] } },
    });
    expect(
      patchFor(p, { type: "rung", role: "worker", rung: "codex:gpt-6-sol#medium", scored: true }),
    ).toEqual({
      roles: {
        worker: {
          rungs: ["codex:gpt-6-luna#high", "codex:gpt-6-sol#high", "codex:gpt-6-sol#xhigh"],
          defaultRung: null,
        },
      },
    });
  });

  it("cycles routing, toggles isolation, and keeps notify in order", () => {
    expect(patchFor(p, { type: "objective" })).toEqual({ objective: "speed" });
    expect(patchFor(p, { type: "jev" })).toEqual({ jev: { use: "off" } });
    expect(patchFor(p, { type: "isolated", harness: "codex" })).toEqual({
      harness: { codex: { isolated: true } },
    });
    const q = resolveProfile(applyPatch(defaultProfileDoc(), { notify: ["blocked"] }), "q");
    expect(patchFor(q, { type: "notify", moment: "milestone" })).toEqual({
      notify: ["milestone", "blocked"],
    });
    expect(patchFor(p, { type: "model" })).toBeNull();
    expect(patchFor(p, { type: "failover", rung: "x" })).toBeNull();
  });

  it("parses a value editor's text, and a budget cap clears with empty", () => {
    expect(parseNumber("budget.usd", "5.5")).toEqual({ value: 5.5 });
    expect(parseNumber("budget.usd", "")).toEqual({ value: null });
    expect(parseNumber("timeouts.idleMin", "")).toHaveProperty("error");
    expect(parseNumber("budget.minutes", "1.2.3")).toEqual({ error: '"1.2.3" is not a number above 0' });
    expect(parseNumber("budget.tokens", "10.5")).toHaveProperty("error");
    expect(numberPatch("budget.usd", null)).toEqual({ budget: { usd: null } });
    expect(numberPatch("timeouts.wallMin", 60)).toEqual({ timeouts: { wallMin: 60 } });
  });

  it("offers the pickers' options", () => {
    expect(startOptions(p, "worker").map((o) => [o.value, o.current])).toEqual([
      ["", false],
      ["codex:gpt-6-luna#high", false],
      ["codex:gpt-6-sol#medium", true],
      ["codex:gpt-6-sol#high", false],
      ["codex:gpt-6-sol#xhigh", false],
    ]);
    withHome();
    const c = loadCatalog({ timings: false });
    const models = catalogQuery({ scoredOnly: false, limit: 1000 }, p.billing).models;
    const standIns = failoverOptions(p, models, c, "codex:gpt-6-sol#high");
    expect(standIns[0]).toEqual({ value: "", title: "none", current: false });
    expect(standIns.some((o) => o.value.startsWith("codex:"))).toBe(false);
    expect(standIns.some((o) => o.value === "claude-code:claude-opus-5-5#xhigh")).toBe(true);
    const likes = treatLikeOptions(c);
    expect(likes.map((o) => o.value)).toContain("gpt-6-sol#medium");
    expect(likes.map((o) => o.value)).not.toContain("claude-opus-5-5#high");
  });
});
