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
import { BUILTIN_ROLES, defaultProfileDoc, hostDefaultsDoc } from "../../src/domain/profile.ts";
import { claudeAgentsDir, configDir } from "../../src/infra/paths.ts";
import { agentLinkState, linkedProfiles } from "../../src/services/agent-links.ts";
import {
  activate,
  createProfile,
  deleteProfile,
  diffNamed,
  patchProfile,
  resetProfile,
  resetHostDefaults,
  profileService,
  unbind,
} from "../../src/services/profile-service.ts";
import {
  activeName,
  agentsRoot,
  enforcementOf,
  getProfile,
  listProfiles,
  profileFor,
  profilesDir,
  projectsFile,
  readProfileDoc,
  readProjects,
  roleEnforcement,
  validateNamed,
} from "../../src/services/profile-store.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
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
    expect(profileFor(null, "claude-code").roles.worker.defaultRung).toBe("codex:gpt-6-sol#medium");
    expect(validateNamed(undefined, null, "claude-code")).toEqual({ errors: [], warnings: [] });
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
    expect(() => readProfileDoc("new")).toThrow(
      expect.objectContaining({
        code: "E_CONFIG_NEWER_SCHEMA",
        fix: "upgrade catherd: bun add -g catherd-cli@latest (or run bunx catherd-cli@latest <command>)",
      }),
    );
  });
});

describe("patchProfile", () => {
  it("creates a missing profile from the default, and keeps fields it does not know", () => {
    withHome();
    const r = patchProfile("default", { budget: { usd: 5 } }, { host: "claude-code" });
    expect([r.saved, r.errors, r.diff]).toEqual([true, [], [{ path: "budget.usd", before: null, after: 5 }]]);
    const doc = JSON.parse(readFileSync(file("default"), "utf8"));
    writeFileSync(
      file("default"),
      JSON.stringify({ ...doc, theme: "ginger", roles: { ...doc.roles, tester: { enabled: true } } }),
    );
    patchProfile(undefined, { timeouts: { idleMin: 5 } }, { host: "claude-code" });
    const after = JSON.parse(readFileSync(file("default"), "utf8"));
    expect([after.theme, after.roles.tester, after.budget, after.timeouts]).toEqual([
      "ginger",
      { enabled: true },
      { usd: 5 },
      { idleMin: 5, wallMin: 90 },
    ]);
  });

  it("reads a profile a newer catherd wrote, warns about the values it does not know, and keeps them", () => {
    withHome();
    mkdirSync(profilesDir(), { recursive: true });
    const doc = defaultProfileDoc();
    writeFileSync(
      file("default"),
      JSON.stringify({
        ...doc,
        roles: { ...doc.roles, reviewer: { ...doc.roles?.reviewer, access: "network-off" } },
      }),
    );
    expect(getProfile("default", "claude-code").roles.reviewer.access).toBe("read-only");
    expect(validateNamed("default", null, "claude-code").warnings).toContainEqual({
      path: "roles.reviewer.access",
      message:
        '"network-off" is not a value this catherd knows (a newer one wrote it?); it is read as read-only',
      fix: "upgrade catherd (bun add -g catherd-cli@latest), or set a value this version knows",
    });
    expect(patchProfile("default", { budget: { usd: 5 } }, { host: "claude-code" }).saved).toBe(true);
    expect(JSON.parse(readFileSync(file("default"), "utf8")).roles.reviewer.access).toBe("network-off");
  });

  it("saves a repair: a patch that removes one of two errors and adds none, listing the one still open", () => {
    withHome();
    mkdirSync(profilesDir(), { recursive: true });
    const doc = defaultProfileDoc();
    // two errors, as a hand edit (or a catherd before 1.2) could leave them
    const broken = { ...doc, roles: { ...doc.roles, worker: { ...doc.roles?.worker, enabled: false } } };
    writeFileSync(
      file("default"),
      JSON.stringify({ ...broken, failover: { "codex:gpt-6-sol#high": "codex:gpt-6-luna#high" } }),
    );
    expect(validateNamed("default", null, "claude-code").errors).toHaveLength(2);
    const r = patchProfile("default", { roles: { worker: { enabled: true } } }, { host: "claude-code" });
    expect(r.saved).toBe(true);
    expect(r.errors.map((e) => e.message)).toEqual([
      "stand-in codex:gpt-6-luna#high draws on the same quota as codex:gpt-6-sol#high, which is out when codex:gpt-6-sol#high hits its limit",
    ]);
    expect(JSON.parse(readFileSync(file("default"), "utf8")).roles.worker.enabled).toBe(true);
  });

  it("refuses a patch that adds an error, even one that removes another", () => {
    withHome();
    mkdirSync(profilesDir(), { recursive: true });
    const doc = defaultProfileDoc();
    const broken = { ...doc, roles: { ...doc.roles, worker: { ...doc.roles?.worker, enabled: false } } };
    writeFileSync(file("default"), JSON.stringify(broken));
    const before = readFileSync(file("default"), "utf8");
    const r = patchProfile(
      "default",
      { roles: { worker: { enabled: true }, writer: { rungs: [] } } },
      { host: "claude-code" },
    );
    expect(r.saved).toBe(false);
    expect(r.errors.map((e) => e.message)).toEqual(["the writer role has no usable rung"]);
    expect(readFileSync(file("default"), "utf8")).toBe(before);
  });

  it("writes nothing when the result is invalid, and returns the errors", () => {
    withHome();
    patchProfile("default", {}, { host: "claude-code" });
    const before = readFileSync(file("default"), "utf8");
    const r = patchProfile("default", { roles: { worker: { enabled: false } } }, { host: "claude-code" });
    expect(r.saved).toBe(false);
    expect(r.errors.map((e) => e.message)).toEqual(["the worker cannot be disabled"]);
    expect(readFileSync(file("default"), "utf8")).toBe(before);
  });

  it("saves over the profile it was shown (expect), and writes nothing when it changed on disk since", () => {
    withHome();
    patchProfile("default", {}, { host: "claude-code" });
    const shown = readProfileDoc("default");
    expect(
      patchProfile("default", { objective: "speed" }, { host: "claude-code", expect: shown }).saved,
    ).toBe(true);
    expect(readProfileDoc("default").objective).toBe("speed");

    const seen = readProfileDoc("default");
    // another process writes the profile between the preview and the save
    patchProfile("default", { objective: "cost" }, { host: "claude-code" });
    const onDisk = readFileSync(file("default"), "utf8");
    const r = patchProfile("default", { budget: { usd: 5 } }, { host: "claude-code", expect: seen });
    expect(r.saved).toBe(false);
    expect(r.errors).toEqual([
      {
        path: "profile",
        message: 'profile "default" changed on disk since it was shown',
        fix: "check the changes and save again",
      },
    ]);
    expect(r.diff).toEqual([]);
    expect(readFileSync(file("default"), "utf8")).toBe(onDisk);
  });

  it("stores rungs and failover keys as written, and every field profile_set can set", () => {
    withHome();
    const r = patchProfile(
      "default",
      {
        roles: { reviewer: { rungs: ["claude-code:claude-opus-5-5#high"], access: "read-only" } },
        failover: { "claude-code:claude-opus-5-5#high": "codex:gpt-6-sol#high" },
        harness: { "claude-code": { isolated: true } },
        jev: { use: "off" },
        billing: { opencode: "subscription" },
        preflight: { confirm: true },
      },
      { host: "claude-code" },
    );
    expect(r.errors).toEqual([]);
    const p = getProfile("default", "claude-code");
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
           for (let i = 1; i <= 8; i++) patchProfile("default", ${field === "budget" ? "{ budget: { minutes: i } }" : "{ timeouts: { idleMin: i } }"}, {host:"claude-code"});`,
        ],
        { env: { ...process.env, CATHERD_HOME: home }, stdout: "ignore", stderr: "inherit" },
      );
    const [a, b] = [writer("budget"), writer("timeouts")];
    expect([await a.exited, await b.exited]).toEqual([0, 0]);
    const p = getProfile("default", "claude-code");
    expect([p.budget.minutes, p.timeouts.idleMin]).toEqual([8, 8]);
    expect(existsSync(join(configDir(), "profiles.lock"))).toBe(false);
  }, 30_000);
});

describe("agent files and links", () => {
  it("links the active profile's native agents and says a new session needs them", () => {
    withHome();
    const r = patchProfile("default", {}, { host: "claude-code" });
    expect(r.newSessionNeededFor).toEqual(DEFAULT_AGENTS);
    expect(links()).toEqual(DEFAULT_AGENTS.map((a) => `${a}.md`));
    const link = join(claudeAgentsDir(), `${ARCHITECT}.md`);
    expect(readlinkSync(link)).toBe(join(agentsRoot(), "default", `${ARCHITECT}.md`));
    expect(
      patchProfile("default", { budget: { usd: 1 } }, { host: "claude-code" }).newSessionNeededFor,
    ).toEqual([]);
  });

  it("relinks on a change: the new agent is linked and needs a session, the old one is pruned", () => {
    withHome();
    patchProfile("default", {}, { host: "claude-code" });
    const r = patchProfile(
      "default",
      { roles: { verifier: { rungs: ["claude:claude-opus-5-5#medium"] } } },
      { host: "claude-code" },
    );
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
    patchProfile("default", {}, { host: "claude-code" });
    const r = patchProfile(
      "default",
      { roles: { verifier: { access: "read-only" } } },
      { host: "claude-code" },
    );
    expect(r.newSessionNeededFor).toEqual(["catherd-default-verifier-claude-opus-5-5-low"]);
    expect([r.saved, r.warnings.length > 0]).toEqual([true, true]);
  });

  it("links the active profile and every repo-bound one, and a non-active save links nothing new", () => {
    withHome();
    patchProfile("default", {}, { host: "claude-code" });
    createProfile("fast", undefined, "claude-code");
    expect(links()).toEqual(DEFAULT_AGENTS.map((a) => `${a}.md`));
    expect(existsSync(join(agentsRoot(), "fast"))).toBe(true);
    const r = activate("fast", "/r/app", "claude-code");
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
    patchProfile("default", {}, { host: "claude-code" });
    expect(readFileSync(join(claudeAgentsDir(), "mine.md"), "utf8")).toContain("name: mine");
    writeFileSync(join(claudeAgentsDir(), "catherd-default-verifier-claude-opus-5-5-medium.md"), "user file");
    const before = readFileSync(file("default"), "utf8");
    expect(() =>
      patchProfile(
        "default",
        { roles: { verifier: { rungs: ["claude:claude-opus-5-5#medium"] } } },
        { host: "claude-code" },
      ),
    ).toThrow(expect.objectContaining({ code: "E_CONFIG_INVALID" }));
    expect(readFileSync(file("default"), "utf8")).toBe(before);
    expect(
      lstatSync(
        join(claudeAgentsDir(), "catherd-default-verifier-claude-opus-5-5-medium.md"),
      ).isSymbolicLink(),
    ).toBe(false);
  });

  it("reports missing and stale links, and activating the profile makes them current", () => {
    withHome();
    patchProfile("default", {}, { host: "claude-code" });
    expect(agentLinkState("claude-code")).toEqual({ missing: [], stale: [], ok: DEFAULT_AGENTS });
    writeFileSync(join(agentsRoot(), "default", `${ARCHITECT}.md`), "edited");
    rmSync(join(claudeAgentsDir(), `${VERIFIER}.md`));
    expect(agentLinkState("claude-code")).toEqual({ missing: [VERIFIER], stale: [ARCHITECT], ok: [] });
    activate("default", null, "claude-code");
    expect(agentLinkState("claude-code").ok).toEqual(DEFAULT_AGENTS);
  });
});

describe("create, delete, diff", () => {
  it("copies a profile, and refuses a name that exists", () => {
    withHome();
    patchProfile("default", { objective: "speed" }, { host: "claude-code" });
    expect(createProfile("fast", "default", "claude-code").saved).toBe(true);
    expect(getProfile("fast", "claude-code").objective).toBe("speed");
    expect(JSON.parse(readFileSync(file("fast"), "utf8")).name).toBe("fast");
    expect(() => createProfile("fast", undefined, "claude-code")).toThrow(
      expect.objectContaining({ code: "E_INPUT_INVALID" }),
    );
    expect(diffNamed("default", "fast", "claude-code")).toEqual([]);
    expect(() => createProfile("copy", "nope", "claude-code")).toThrow(
      expect.objectContaining({ code: "E_INPUT_INVALID" }),
    );
    expect(existsSync(file("copy"))).toBe(false);
  });

  it("refuses to create or copy over the built-in default, which exists without a file", () => {
    withHome();
    expect(() => createProfile("default", undefined, "claude-code")).toThrow(
      expect.objectContaining({ code: "E_INPUT_INVALID" }),
    );
    expect(existsSync(file("default"))).toBe(false);
  });

  it("validates a copy before writing it, and writes nothing when it is invalid", () => {
    withHome();
    patchProfile("default", {}, { host: "claude-code" });
    const doc = JSON.parse(readFileSync(file("default"), "utf8"));
    doc.roles.worker = { ...doc.roles.worker, enabled: false };
    writeFileSync(file("bad"), JSON.stringify({ ...doc, name: "bad" }));
    const r = createProfile("copy", "bad", "claude-code");
    expect(r.saved).toBe(false);
    expect(r.errors.map((e) => e.message)).toEqual(["the worker cannot be disabled"]);
    expect([existsSync(file("copy")), existsSync(join(agentsRoot(), "copy"))]).toEqual([false, false]);
  });

  it("refuses to delete the active or a bound profile; deletes another with its agent files", () => {
    withHome();
    patchProfile("default", {}, { host: "claude-code" });
    createProfile("fast", undefined, "claude-code");
    createProfile("team", undefined, "claude-code");
    const repo = tempRepo();
    activate("team", repo, "claude-code");
    expect(() => deleteProfile("default")).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
    expect(() => deleteProfile("team")).toThrow(`bound to ${repo}`);
    deleteProfile("fast");
    expect(listProfiles()).toEqual(["default", "team"]);
    expect(existsSync(join(agentsRoot(), "fast"))).toBe(false);
  });

  it("deletes a profile bound only to repos that no longer exist, and prunes those bindings", () => {
    withHome();
    createProfile("team", undefined, "claude-code");
    const gone = tempRepo();
    const kept = tempRepo();
    createProfile("other", undefined, "claude-code");
    activate("team", gone, "claude-code");
    activate("other", kept, "claude-code");
    rmSync(gone, { recursive: true, force: true });
    deleteProfile("team");
    expect(listProfiles()).toEqual(["default", "other"]);
    expect(readProjects().bindings).toEqual({ [kept]: "other" });
  });

  it("unbind removes a repo's binding and relinks; a repo with no binding is refused", () => {
    withHome();
    createProfile("team", undefined, "claude-code");
    const repo = tempRepo();
    activate("team", repo, "claude-code");
    expect(linkedProfiles()).toEqual(["default", "team"]);
    const r = unbind(repo, "claude-code");
    expect([r.repo, r.was]).toEqual([repo, "team"]);
    expect([activeName(repo), linkedProfiles()]).toEqual(["default", ["default"]]);
    expect(() => unbind(repo, "claude-code")).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
  });

  it("unbind clears a binding whose profile is gone (doctor's fix for it)", () => {
    withHome();
    const repo = tempRepo();
    writeJsonAtomic(projectsFile(), { schema: 1, bindings: { [repo]: "gone" } });
    expect(unbind(repo, "codex")).toEqual({
      repo,
      was: "gone",
      linked: [],
      pruned: [],
      newSessionNeededFor: [],
    });
    expect(readProjects().bindings).toEqual({});
  });
});

describe("resetProfile and linkedProfiles", () => {
  it("writes the default profile over a changed one, and links it when it is linked", () => {
    withHome();
    patchProfile(
      "default",
      {
        budget: { usd: 3 },
        roles: { verifier: { rungs: ["claude:claude-opus-5-5#max"] } },
      },
      { host: "claude-code" },
    );
    const r = resetProfile("default", "claude-code");
    expect([r.saved, getProfile("default", "claude-code").budget]).toEqual([true, {}]);
    expect(r.newSessionNeededFor).toEqual([
      "catherd-default-verifier-claude-opus-5-5-low",
      "catherd-default-verifier-claude-opus-5-5-max",
    ]);
    expect(r.pruned).toEqual(["catherd-default-verifier-claude-opus-5-5-max.md"]);
  });

  it("refuses to link over a user's own file, and leaves it and the profile intact", () => {
    withHome();
    patchProfile(
      "default",
      { roles: { verifier: { rungs: ["claude:claude-opus-5-5#max"] } } },
      { host: "claude-code" },
    );
    const user = join(claudeAgentsDir(), `${VERIFIER}.md`);
    writeFileSync(user, "user file");
    const before = readFileSync(file("default"), "utf8");
    expect(() => resetProfile("default", "claude-code")).toThrow(
      expect.objectContaining({ code: "E_CONFIG_INVALID", message: `${user} exists and is not catherd's` }),
    );
    expect([lstatSync(user).isSymbolicLink(), readFileSync(user, "utf8")]).toEqual([false, "user file"]);
    expect(readFileSync(file("default"), "utf8")).toBe(before);
  });

  it("lists the active profile and every repo-bound one, once each", () => {
    withHome();
    createProfile("fast", undefined, "claude-code");
    createProfile("team", undefined, "claude-code");
    activate("fast", "/r/a", "claude-code");
    activate("fast", "/r/b", "claude-code");
    expect(linkedProfiles()).toEqual(["default", "fast"]);
  });
});

describe("enforcement", () => {
  it("is the backend's for the role's access, and advisory for native Claude", () => {
    expect(enforcementOf("codex:gpt-6-sol#high", "read-only")).toBe("enforced");
    expect(enforcementOf("claude-code:claude-sonnet-5#high", "read-only")).toBe("advisory");
    expect(enforcementOf("claude:claude-opus-5-5#high", "read-only")).toBe("advisory");
    withHome();
    expect(roleEnforcement(getProfile("default", "claude-code"))).toMatchObject({
      architect: "advisory",
      worker: "enforced",
      reviewer: "enforced",
    });
  });
});

describe("host-specific profiles", () => {
  it("legacy_bytes_and_native_rejection leaves materialized bytes untouched and names exact headless alternatives", () => {
    withHome();
    const legacy = { ...defaultProfileDoc(), roles: structuredClone(BUILTIN_ROLES) };
    mkdirSync(profilesDir(), { recursive: true });
    const file = join(profilesDir(), "default.json");
    writeFileSync(file, JSON.stringify(legacy, null, 4));
    const before = readFileSync(file, "utf8");
    expect(getProfile("default", "codex").roles.architect.rungs).toEqual(["claude:claude-opus-5-5#high"]);
    const v = validateNamed("default", null, "codex");
    expect(v.errors.some((e) => e.fix?.includes("claude-code:claude-opus-5-5#high"))).toBe(true);
    legacy.roles.architect.rungs = ["claude-code:claude-opus-5-5#high"];
    legacy.roles.verifier.rungs = ["claude-code:claude-opus-5-5#low"];
    expect(readFileSync(file, "utf8")).toBe(before);
    writeFileSync(file, JSON.stringify(legacy));
    expect(validateNamed("default", null, "codex").errors).toEqual([]);
  });

  it("saves a one-role repair of native Claude roles under codex, keeping the other role's error open", () => {
    withHome();
    mkdirSync(profilesDir(), { recursive: true });
    writeFileSync(
      file("default"),
      JSON.stringify({ ...defaultProfileDoc(), roles: structuredClone(BUILTIN_ROLES) }),
    );
    expect(validateNamed("default", null, "codex").errors).toHaveLength(2);
    const r = patchProfile(
      "default",
      { roles: { architect: { rungs: ["claude-code:claude-opus-5-5#high"] } } },
      { host: "codex" },
    );
    expect(r).toMatchObject({ saved: true, linked: [], pruned: [] });
    expect(r.errors.map((e) => e.path)).toEqual(["roles.verifier.rungs"]);
    expect(readProfileDoc("default").roles?.architect?.rungs).toEqual(["claude-code:claude-opus-5-5#high"]);
    expect(existsSync(claudeAgentsDir())).toBe(false);
    const done = patchProfile(
      "default",
      { roles: { verifier: { rungs: ["claude-code:claude-opus-5-5#low"] } } },
      { host: "codex" },
    );
    expect(done.saved).toBe(true);
    expect(done.errors).toEqual([]);
  });

  it("narrow_reset_and_stale_preview preserves future fields and refuses changed disk under the existing lock", () => {
    withHome();
    const doc = {
      ...defaultProfileDoc(),
      theme: "future",
      roles: {
        ...structuredClone(BUILTIN_ROLES),
        architect: { ...BUILTIN_ROLES.architect, defaultRung: BUILTIN_ROLES.architect.rungs[0], future: 17 },
        verifier: { ...BUILTIN_ROLES.verifier, defaultRung: BUILTIN_ROLES.verifier.rungs[0], future: true },
      },
    };
    mkdirSync(profilesDir(), { recursive: true });
    const file = join(profilesDir(), "default.json");
    writeFileSync(file, JSON.stringify(doc));
    const before = readFileSync(file, "utf8");
    const p = resetHostDefaults("default", "codex", { preview: true });
    expect(p.errors).toEqual([]);
    expect(p.expect).toEqual(doc);
    expect(p.diff.map((x) => x.path).sort()).toEqual([
      "roles.architect.defaultRung",
      "roles.architect.rungs",
      "roles.verifier.defaultRung",
      "roles.verifier.rungs",
    ]);
    expect(readFileSync(file, "utf8")).toBe(before);
    writeFileSync(file, JSON.stringify({ ...doc, objective: "speed" }));
    const reviewed = { profile: p.profile, host: p.host };
    expect(p).toMatchObject({ profile: "default", host: "codex" });
    expect(resetHostDefaults("default", "codex", { preview: false, expect: p.expect, reviewed }).saved).toBe(
      false,
    );
    const fresh = resetHostDefaults("default", "codex", { preview: true });
    const ok = { profile: fresh.profile, host: fresh.host };
    // a preview approves one profile on one host: reusing it elsewhere is refused without a write
    const elsewhere = readFileSync(file, "utf8");
    for (const [n, h] of [
      ["default", "claude-code"],
      ["other", "codex"],
    ] as const) {
      const r = resetHostDefaults(n, h, { preview: false, expect: fresh.expect, reviewed: ok });
      expect(r.saved).toBe(false);
      expect(r.errors[0]?.message).toContain('the preview was for profile "default" on host codex');
    }
    expect(readFileSync(file, "utf8")).toBe(elsewhere);
    expect(
      resetHostDefaults("default", "codex", { preview: false, expect: fresh.expect, reviewed: ok }).saved,
    ).toBe(true);
    expect(readProfileDoc("default")).toEqual({
      ...hostDefaultsDoc(doc),
      objective: "speed",
      name: "default",
    });
    expect(existsSync(claudeAgentsDir())).toBe(false);
  });

  it("resolves the host callback per operation and skips all Claude filesystem work on Codex saves", () => {
    withHome();
    let host: "codex" | "claude-code" | "unknown" = "unknown";
    const port = profileService(() => ({ host, session: null, conflict: null }));
    expect(port.validate().valid).toBe(false);
    host = "codex";
    expect(port.forRepo(null).roles.architect?.rungs).toEqual(["codex:gpt-6.1-sol#high"]);
    expect(port.set(undefined, { budget: { usd: 8 } }).saved).toBe(true);
    expect(existsSync(claudeAgentsDir())).toBe(false);
    host = "claude-code";
    expect(port.forRepo(null).roles.architect?.rungs).toEqual(["claude:claude-opus-5-5#high"]);
    host = "unknown";
    expect(() => port.forRepo(null)).toThrow("host");
    expect(readProfileDoc("default").roles?.architect?.rungs).toBeUndefined();
  });
});

it("Codex-only saves and activation preserve existing Claude links byte for byte", () => {
  withHome();
  expect(createProfile("native", undefined, "claude-code").saved).toBe(true);
  activate("native", null, "claude-code");
  const names = readdirSync(claudeAgentsDir());
  const before = names.map((n) => ({
    name: n,
    target: readlinkSync(join(claudeAgentsDir(), n)),
    text: readFileSync(join(claudeAgentsDir(), n), "utf8"),
  }));
  expect(createProfile("codex", undefined, "codex").saved).toBe(true);
  activate("codex", null, "codex");
  expect(patchProfile("codex", { budget: { usd: 2 } }, { host: "codex" }).saved).toBe(true);
  expect(readdirSync(claudeAgentsDir())).toEqual(names);
  for (const f of before) {
    expect(readlinkSync(join(claudeAgentsDir(), f.name))).toBe(f.target);
    expect(readFileSync(join(claudeAgentsDir(), f.name), "utf8")).toBe(f.text);
  }
});

it("Codex host switches preserve the same profile's omitted-default Claude artifacts", () => {
  withHome();
  const repo = tempRepo();
  resetProfile("default", "claude-code");
  const before = DEFAULT_AGENTS.map((name) => ({
    name,
    target: readlinkSync(join(claudeAgentsDir(), `${name}.md`)),
    text: readFileSync(join(claudeAgentsDir(), `${name}.md`), "utf8"),
  }));
  expect(patchProfile("default", { budget: { usd: 2 } }, { host: "codex" }).saved).toBe(true);
  expect(activate("default", null, "codex").pruned).toEqual([]);
  expect(activate("default", repo, "codex").pruned).toEqual([]);
  expect(unbind(repo, "codex").pruned).toEqual([]);
  expect(links()).toEqual(DEFAULT_AGENTS.map((name) => `${name}.md`));
  for (const f of before) {
    expect(readlinkSync(join(claudeAgentsDir(), `${f.name}.md`))).toBe(f.target);
    expect(readFileSync(join(claudeAgentsDir(), `${f.name}.md`), "utf8")).toBe(f.text);
  }
});

for (const host of ["claude-code", "codex"] as const)
  it(`prunes owned agents when a profile loses its last native role on ${host}`, () => {
    withHome();
    expect(resetProfile("default", "claude-code").saved).toBe(true);
    if (host === "codex")
      writeFileSync(
        file("default"),
        JSON.stringify({ ...defaultProfileDoc(), roles: structuredClone(BUILTIN_ROLES) }),
      );
    writeFileSync(join(claudeAgentsDir(), "mine.md"), "user agent");
    const r = patchProfile(
      "default",
      {
        roles: {
          architect: { rungs: ["codex:gpt-6-sol#high"], defaultRung: null },
          verifier: { rungs: ["codex:gpt-6-sol#low"], defaultRung: null },
        },
      },
      { host },
    );
    expect(r.saved).toBe(true);
    expect(r.pruned).toEqual(DEFAULT_AGENTS.map((name) => `${name}.md`));
    expect(r.newSessionNeededFor).toEqual(DEFAULT_AGENTS);
    expect(links()).toEqual(["mine.md"]);
    expect(readFileSync(join(claudeAgentsDir(), "mine.md"), "utf8")).toBe("user agent");
    expect(existsSync(join(agentsRoot(), "default"))).toBe(false);
  });

it("Codex deletion cleans a removed profile's owned artifacts without touching other profiles or user agents", () => {
  withHome();
  createProfile("team", undefined, "claude-code");
  createProfile("other", undefined, "claude-code");
  const gone = tempRepo();
  const kept = tempRepo();
  activate("team", gone, "claude-code");
  activate("other", kept, "claude-code");
  writeFileSync(join(claudeAgentsDir(), "mine.md"), "user agent");
  const other = links().filter((name) => !name.startsWith("catherd-team-"));
  const before = other.map((name) => ({
    name,
    target: name === "mine.md" ? null : readlinkSync(join(claudeAgentsDir(), name)),
    text: readFileSync(join(claudeAgentsDir(), name), "utf8"),
  }));
  const removed = links().filter((name) => name.startsWith("catherd-team-"));
  rmSync(gone, { recursive: true, force: true });
  const r = deleteProfile("team");
  expect(r.pruned).toEqual(removed);
  expect(r.newSessionNeededFor).toEqual(removed.map((name) => name.slice(0, -3)));
  expect(existsSync(join(agentsRoot(), "team"))).toBe(false);
  expect(readProjects().bindings).toEqual({ [kept]: "other" });
  expect(links()).toEqual(other);
  for (const f of before) {
    if (f.target !== null) expect(readlinkSync(join(claudeAgentsDir(), f.name))).toBe(f.target);
    expect(readFileSync(join(claudeAgentsDir(), f.name), "utf8")).toBe(f.text);
  }
});

it("Codex deletion without owned artifacts creates no Claude files", () => {
  withHome();
  createProfile("unused", undefined, "codex");
  expect(deleteProfile("unused")).toEqual({ linked: [], pruned: [], newSessionNeededFor: [] });
  expect(existsSync(claudeAgentsDir())).toBe(false);
  expect(existsSync(agentsRoot())).toBe(false);
});
