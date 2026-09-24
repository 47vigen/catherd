import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import { configDir } from "../../src/paths.ts";
import {
  activeProfileName,
  defaultProfile,
  listProfiles,
  saveProfile,
  setActiveProfile,
} from "../../src/profile/profile.ts";
import { loadCatalog, saveTreatLike } from "../../src/routing/catalog.ts";
import { deleteProfile, nameError, saveAndActivate } from "../../src/tui/profiles.ts";
import { withHome } from "../helpers.ts";

describe("profile files", () => {
  beforeEach(() => {
    withHome();
    process.env.CATHERD_CLAUDE_AGENTS_DIR = mkdtempSync(join(tmpdir(), "catherd-agents-"));
  });

  it("writes a treat-like that loadCatalog reads back, keeping the earlier ones", () => {
    saveTreatLike("gpt-6-luna#max", "gpt-6-sol#xhigh");
    saveTreatLike("gpt-6-luna#xhigh", "gpt-6-sol#high");
    expect(loadCatalog().treatLike).toMatchObject({
      "gpt-6-luna#max": "gpt-6-sol#xhigh",
      "gpt-6-luna#xhigh": "gpt-6-sol#high",
    });
  });

  it("saves through the one writer and makes the profile active", () => {
    saveAndActivate({ ...defaultProfile(), name: "fast" }, loadCatalog());
    expect(activeProfileName()).toBe("fast");
    expect(listProfiles()).toContain("fast");
  });

  it("deletes a profile together with its agent files", () => {
    saveAndActivate({ ...defaultProfile(), name: "fast" }, loadCatalog());
    saveAndActivate(defaultProfile(), loadCatalog());
    expect(existsSync(join(configDir(), "agents", "fast"))).toBe(true);
    deleteProfile("fast");
    expect(listProfiles()).not.toContain("fast");
    expect(existsSync(join(configDir(), "agents", "fast"))).toBe(false);
  });

  it("refuses to delete the active profile, or one a repo is bound to", () => {
    saveProfile(defaultProfile());
    saveProfile({ ...defaultProfile(), name: "fast" });
    setActiveProfile("default");
    expect(() => deleteProfile("default")).toThrow(/active profile/);
    setActiveProfile("fast", "/r/app");
    expect(() => deleteProfile("fast")).toThrow(/bound to \/r\/app/);
    expect(listProfiles()).toContain("fast");
  });

  it("accepts short lowercase names that are free", () => {
    expect(nameError("fast-2", ["default"])).toBeNull();
    expect(nameError("Fast", [])).toMatch(/lowercase/);
    expect(nameError("", [])).toMatch(/lowercase/);
    expect(nameError("default", ["default"])).toMatch(/already exists/);
  });
});
