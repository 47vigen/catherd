import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { claudeAgentsDir, configDir } from "../../src/infra/paths.ts";
import {
  activate,
  activeName,
  agentLinkState,
  agentsRoot,
  createProfile,
  deleteProfile,
  diffNamed,
  enforcementOf,
  getProfile,
  linkedProfiles,
  listProfiles,
  patchProfile,
  profileFor,
  profilesDir,
  readProfileDoc,
  readProjects,
  relink,
  resetProfile,
  roleEnforcement,
  unbind,
  validateNamed,
} from "../../src/services/profile-service.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const ARCHITECT = "catherd-default-architect-claude-opus-5-5-high";
const VERIFIER = "catherd-default-verifier-claude-opus-5-5-low";
const DEFAULT_AGENTS = [ARCHITECT, VERIFIER];
const links = () => (existsSync(claudeAgentsDir()) ? readdirSync(claudeAgentsDir()).sort() : []);
const file = (name: string) => join(profilesDir(), `${name}.json`);

describe("reading profiles", () => {
  it("serves the built-in default before any file exists", () => {
    withHome();
    expect(listProfiles()).toEqual(["default"]);
    expect(activeName()).toBe("default");
    expect(profileFor(null).roles.worker.defaultRung).toBe("codex:gpt-6-sol#medium");
    expect(validateNamed()).toEqual({ errors: [], warnings: [] });
  });

  it("refuses a 0.x profile with the init fix, and a newer schema with the upgrade fix", () => {
    withHome();
    mkdirSync(profilesDir(), { recursive: true });
    writeFileSync(file("old"), JSON.stringify({ name: "old", objective: "cost", roles: {} }));
    expect(() => readProfileDoc("old")).toThrow(
      expect.objectContaining({
        code: "E_CONFIG_INVALID",
        fix: "run catherd init, which moves 0.x files aside and writes 1.0 ones",
      }),
    );
    writeFileSync(file("new"), JSON.stringify({ schema: 2 }));
    expect(() => readProfileDoc("new")).toThrow(expect.objectContaining({ code: "E_CONFIG_NEWER_SCHEMA" }));
  });
});

describe("patchProfile", () => {
  it("creates a missing profile from the default, and keeps fields it does not know", () => {
    withHome();
    const r = patchProfile("default", { budget: { usd: 5 } });
    expect([r.saved, r.errors, r.diff]).toEqual([true, [], [{ path: "budget.usd", before: null, after: 5 }]]);
    const doc = JSON.parse(readFileSync(file("default"), "utf8"));
    writeFileSync(
      file("default"),
      JSON.stringify({ ...doc, theme: "ginger", roles: { ...doc.roles, tester: { enabled: true } } }),
    );
    patchProfile(undefined, { timeouts: { idleMin: 5 } });
    const after = JSON.parse(readFileSync(file("default"), "utf8"));
    expect([after.theme, after.roles.tester, after.budget, after.timeouts]).toEqual([
      "ginger",
      { enabled: true },
      { usd: 5 },
      { idleMin: 5, wallMin: 90 },
    ]);
  });

  it("writes nothing when the result is invalid, and returns the errors", () => {
    withHome();
    patchProfile("default", {});
    const before = readFileSync(file("default"), "utf8");
    const r = patchProfile("default", { roles: { worker: { enabled: false } } });
    expect(r.saved).toBe(false);
    expect(r.errors.map((e) => e.message)).toEqual(["the worker cannot be disabled"]);
    expect(readFileSync(file("default"), "utf8")).toBe(before);
  });

  it("stores rungs and failover keys as written, and every field profile_set can set", () => {
    withHome();
    const r = patchProfile("default", {
      roles: { reviewer: { rungs: ["claude-code:claude-opus-5-5#high"], access: "read-only" } },
      failover: { "claude-code:claude-opus-5-5#high": "codex:gpt-6-sol#high" },
      harness: { "claude-code": { isolated: true } },
      jev: { use: "off" },
      billing: { opencode: "subscription" },
      preflight: { confirm: true },
    });
    expect(r.errors).toEqual([]);
    const p = getProfile("default");
    expect(p.failover["claude-code:claude-opus-5-5#high"]).toBe("codex:gpt-6-sol#high");
    expect([p.harness["claude-code"], p.jev, p.billing.opencode, p.preflight]).toEqual([
      { isolated: true },
      { use: "off" },
      "subscription",
      { confirm: true },
    ]);
  });

  it("serialises writers across processes, so no update is lost", async () => {
    const home = withHome();
    const svc = join(import.meta.dir, "..", "..", "src", "services", "profile-service.ts");
    const writer = (field: string) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { patchProfile } = await import(${JSON.stringify(svc)});
           for (let i = 1; i <= 8; i++) patchProfile("default", ${field === "budget" ? "{ budget: { minutes: i } }" : "{ timeouts: { idleMin: i } }"});`,
        ],
        { env: { ...process.env, CATHERD_HOME: home }, stdout: "ignore", stderr: "inherit" },
      );
    const [a, b] = [writer("budget"), writer("timeouts")];
    expect([await a.exited, await b.exited]).toEqual([0, 0]);
    const p = getProfile("default");
    expect([p.budget.minutes, p.timeouts.idleMin]).toEqual([8, 8]);
    expect(existsSync(join(configDir(), "profiles.lock"))).toBe(false);
  }, 30_000);
});

describe("agent files and links", () => {
  it("links the active profile's native agents and says a new session needs them", () => {
    withHome();
    const r = patchProfile("default", {});
    expect(r.newSessionNeededFor).toEqual(DEFAULT_AGENTS);
    expect(links()).toEqual(DEFAULT_AGENTS.map((a) => `${a}.md`));
    const link = join(claudeAgentsDir(), `${ARCHITECT}.md`);
    expect(readlinkSync(link)).toBe(join(agentsRoot(), "default", `${ARCHITECT}.md`));
    expect(patchProfile("default", { budget: { usd: 1 } }).newSessionNeededFor).toEqual([]);
  });

  it("relinks on a change: the new agent is linked and needs a session, the old one is pruned", () => {
    withHome();
    patchProfile("default", {});
    const r = patchProfile("default", { roles: { verifier: { rungs: ["claude:claude-opus-5-5#medium"] } } });
    // the pruned agent is still loaded in the running session too
    expect(r.newSessionNeededFor).toEqual([
      "catherd-default-verifier-claude-opus-5-5-low",
      "catherd-default-verifier-claude-opus-5-5-medium",
    ]);
    expect(r.pruned).toEqual(["catherd-default-verifier-claude-opus-5-5-low.md"]);
    expect(readdirSync(join(agentsRoot(), "default")).sort()).toEqual([
      "catherd-default-architect-claude-opus-5-5-high.md",
      "catherd-default-verifier-claude-opus-5-5-medium.md",
    ]);
  });

  it("asks for a new session when an agent's file changes under the same name", () => {
    withHome();
    patchProfile("default", {});
    const r = patchProfile("default", { roles: { verifier: { access: "read-only" } } });
    expect(r.newSessionNeededFor).toEqual(["catherd-default-verifier-claude-opus-5-5-low"]);
    expect([r.saved, r.warnings.length > 0]).toEqual([true, true]);
  });

  it("links the active profile and every repo-bound one, and a non-active save links nothing new", () => {
    withHome();
    patchProfile("default", {});
    createProfile("fast");
    expect(links()).toEqual(DEFAULT_AGENTS.map((a) => `${a}.md`));
    expect(existsSync(join(agentsRoot(), "fast"))).toBe(true);
    const r = activate("fast", "/r/app");
    expect(r.newSessionNeededFor).toEqual([
      "catherd-fast-architect-claude-opus-5-5-high",
      "catherd-fast-verifier-claude-opus-5-5-low",
    ]);
    expect(links()).toHaveLength(4);
    expect([activeName(), activeName("/r/app"), activeName("/r/other")]).toEqual([
      "default",
      "fast",
      "default",
    ]);
  });

  it("never touches a file it does not own, and refuses to save over one", () => {
    withHome();
    mkdirSync(claudeAgentsDir(), { recursive: true });
    writeFileSync(join(claudeAgentsDir(), "mine.md"), "---\nname: mine\n---\n");
    patchProfile("default", {});
    expect(readFileSync(join(claudeAgentsDir(), "mine.md"), "utf8")).toContain("name: mine");
    writeFileSync(join(claudeAgentsDir(), "catherd-default-verifier-claude-opus-5-5-medium.md"), "user file");
    const before = readFileSync(file("default"), "utf8");
    expect(() =>
      patchProfile("default", { roles: { verifier: { rungs: ["claude:claude-opus-5-5#medium"] } } }),
    ).toThrow(expect.objectContaining({ code: "E_CONFIG_INVALID" }));
    expect(readFileSync(file("default"), "utf8")).toBe(before);
    expect(
      lstatSync(
        join(claudeAgentsDir(), "catherd-default-verifier-claude-opus-5-5-medium.md"),
      ).isSymbolicLink(),
    ).toBe(false);
  });

  it("reports missing and stale links, and relink makes them current", () => {
    withHome();
    patchProfile("default", {});
    expect(agentLinkState()).toEqual({ missing: [], stale: [], ok: DEFAULT_AGENTS });
    writeFileSync(join(agentsRoot(), "default", `${ARCHITECT}.md`), "edited");
    rmSync(join(claudeAgentsDir(), `${VERIFIER}.md`));
    expect(agentLinkState()).toEqual({ missing: [VERIFIER], stale: [ARCHITECT], ok: [] });
    relink();
    expect(agentLinkState().ok).toEqual(DEFAULT_AGENTS);
  });
});

describe("create, delete, diff", () => {
  it("copies a profile, and refuses a name that exists", () => {
    withHome();
    patchProfile("default", { objective: "speed" });
    expect(createProfile("fast", "default").saved).toBe(true);
    expect(getProfile("fast").objective).toBe("speed");
    expect(JSON.parse(readFileSync(file("fast"), "utf8")).name).toBe("fast");
    expect(() => createProfile("fast")).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
    expect(diffNamed("default", "fast")).toEqual([]);
    expect(() => createProfile("copy", "nope")).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
    expect(existsSync(file("copy"))).toBe(false);
  });

  it("validates a copy before writing it, and writes nothing when it is invalid", () => {
    withHome();
    patchProfile("default", {});
    const doc = JSON.parse(readFileSync(file("default"), "utf8"));
    doc.roles.worker = { ...doc.roles.worker, enabled: false };
    writeFileSync(file("bad"), JSON.stringify({ ...doc, name: "bad" }));
    const r = createProfile("copy", "bad");
    expect(r.saved).toBe(false);
    expect(r.errors.map((e) => e.message)).toEqual(["the worker cannot be disabled"]);
    expect([existsSync(file("copy")), existsSync(join(agentsRoot(), "copy"))]).toEqual([false, false]);
  });

  it("refuses to delete the active or a bound profile; deletes another with its agent files", () => {
    withHome();
    patchProfile("default", {});
    createProfile("fast");
    createProfile("team");
    const repo = tempRepo();
    activate("team", repo);
    expect(() => deleteProfile("default")).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
    expect(() => deleteProfile("team")).toThrow(`bound to ${repo}`);
    deleteProfile("fast");
    expect(listProfiles()).toEqual(["default", "team"]);
    expect(existsSync(join(agentsRoot(), "fast"))).toBe(false);
  });

  it("deletes a profile bound only to repos that no longer exist, and prunes those bindings", () => {
    withHome();
    createProfile("team");
    const gone = tempRepo();
    const kept = tempRepo();
    createProfile("other");
    activate("team", gone);
    activate("other", kept);
    rmSync(gone, { recursive: true, force: true });
    deleteProfile("team");
    expect(listProfiles()).toEqual(["default", "other"]);
    expect(readProjects().bindings).toEqual({ [kept]: "other" });
  });

  it("unbind removes a repo's binding and relinks; a repo with no binding is refused", () => {
    withHome();
    createProfile("team");
    const repo = tempRepo();
    activate("team", repo);
    expect(linkedProfiles()).toEqual(["default", "team"]);
    const r = unbind(repo);
    expect([r.repo, r.was]).toEqual([repo, "team"]);
    expect([activeName(repo), linkedProfiles()]).toEqual(["default", ["default"]]);
    expect(() => unbind(repo)).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
  });
});

describe("resetProfile and linkedProfiles", () => {
  it("writes the default profile over a changed one, and links it when it is linked", () => {
    withHome();
    patchProfile("default", {
      budget: { usd: 3 },
      roles: { verifier: { rungs: ["claude:claude-opus-5-5#max"] } },
    });
    const r = resetProfile("default");
    expect([r.saved, getProfile("default").budget]).toEqual([true, {}]);
    expect(r.newSessionNeededFor).toEqual([
      "catherd-default-verifier-claude-opus-5-5-low",
      "catherd-default-verifier-claude-opus-5-5-max",
    ]);
    expect(r.pruned).toEqual(["catherd-default-verifier-claude-opus-5-5-max.md"]);
  });

  it("refuses to link over a user's own file, and leaves it and the profile intact", () => {
    withHome();
    patchProfile("default", { roles: { verifier: { rungs: ["claude:claude-opus-5-5#max"] } } });
    const user = join(claudeAgentsDir(), `${VERIFIER}.md`);
    writeFileSync(user, "user file");
    const before = readFileSync(file("default"), "utf8");
    expect(() => resetProfile("default")).toThrow(
      expect.objectContaining({ code: "E_CONFIG_INVALID", message: `${user} exists and is not catherd's` }),
    );
    expect([lstatSync(user).isSymbolicLink(), readFileSync(user, "utf8")]).toEqual([false, "user file"]);
    expect(readFileSync(file("default"), "utf8")).toBe(before);
  });

  it("lists the active profile and every repo-bound one, once each", () => {
    withHome();
    createProfile("fast");
    createProfile("team");
    activate("fast", "/r/a");
    activate("fast", "/r/b");
    expect(linkedProfiles()).toEqual(["default", "fast"]);
  });
});

describe("enforcement", () => {
  it("is the backend's for the role's access, and advisory for native Claude", () => {
    expect(enforcementOf("codex:gpt-6-sol#high", "read-only")).toBe("enforced");
    expect(enforcementOf("claude-code:claude-sonnet-5#high", "read-only")).toBe("advisory");
    expect(enforcementOf("claude:claude-opus-5-5#high", "read-only")).toBe("advisory");
    withHome();
    expect(roleEnforcement(getProfile("default"))).toMatchObject({
      architect: "advisory",
      worker: "enforced",
      reviewer: "enforced",
    });
  });
});
