import { afterEach, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeOrigin, originDir } from "../../src/infra/paths.ts";
import { addKnowledge, knowledgePath, readKnowledge } from "../../src/services/run-service.ts";
import { gateEnvFile, gateEnvFor, readGateEnv, setGateEnv } from "../../src/services/gate-env.ts";
import { knowledgeFile } from "../../src/services/run-store.ts";
import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const ORIGIN = "git@github.com:Acme/platform.git";

/** A repo with an origin, and a second worktree of it on another branch. */
function worktrees(): { main: string; other: string } {
  withHome();
  const main = tempRepo();
  const git = (...a: string[]) => execFileSync("git", a, { cwd: main, stdio: "ignore" });
  git("remote", "add", "origin", ORIGIN);
  const other = join(tempDir("catherd-wt-"), "auth-kit-cleanup");
  git("worktree", "add", "-q", "-b", "auth", other);
  return { main, other };
}

it("names one repository the same however it is cloned", () => {
  for (const url of [
    "git@github.com:Acme/platform.git",
    "https://github.com/Acme/platform",
    "https://user@GitHub.com/Acme/platform.git/",
    "ssh://git@github.com:22/Acme/platform.git",
  ])
    expect(normalizeOrigin(url)).toBe("github.com/Acme/platform");
});

it("shares what one worktree learned with every other worktree of the repo", async () => {
  const { main, other } = worktrees();
  await addKnowledge(main, "the auth suite needs DOCKER_HOST", new Date("2026-10-02T00:00:00Z"));
  expect(await readKnowledge(other)).toContain("the auth suite needs DOCKER_HOST");
  expect((await knowledgePath(other)).path).toBe(join(originDir(ORIGIN), "knowledge.md"));
});

it("migrates a worktree's toplevel-keyed knowledge on read, once", async () => {
  const { main, other } = worktrees();
  await addKnowledge(main, "shared line", new Date("2026-10-01T00:00:00Z"));
  // written by 1.4 under the worktree's own toplevel key
  const legacy = knowledgeFile(
    execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: other, encoding: "utf8" }).trim(),
  );
  mkdirSync(join(legacy, ".."), { recursive: true });
  writeFileSync(legacy, "- 2026-09-30 M1: kept from M1\n- 2026-10-01 by hand: shared line\n");
  const text = await readKnowledge(other);
  expect(text.split("\n").filter(Boolean)).toEqual([
    "- 2026-10-01 by hand: shared line",
    "- 2026-09-30 M1: kept from M1",
  ]);
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(`${legacy}.migrated`)).toBe(true);
  expect(await readKnowledge(main)).toBe(text);
  expect(readFileSync(join(originDir(ORIGIN), "knowledge.md"), "utf8")).toBe(text);
});

it("keeps the gate environment beside the shared knowledge, and migrates a worktree's own on read", async () => {
  const { main, other } = worktrees();
  await setGateEnv(main, "DOCKER_HOST", { value: "unix:///tmp/d.sock" });
  expect(Object.keys(await readGateEnv(other))).toEqual(["DOCKER_HOST"]);
  expect(await gateEnvFor(other)).toBe(join(originDir(ORIGIN), "gate-env.json"));
  // written by plan 23 under the worktree's own toplevel key
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: other, encoding: "utf8" }).trim();
  const legacy = gateEnvFile(top);
  mkdirSync(join(legacy, ".."), { recursive: true });
  writeFileSync(
    legacy,
    JSON.stringify({
      schema: 1,
      vars: { DOCKER_HOST: { value: "old" }, HTTPS_PROXY: { value: "http://p:3128" } },
    }),
  );
  expect(await readGateEnv(other)).toEqual({
    DOCKER_HOST: { value: "unix:///tmp/d.sock" },
    HTTPS_PROXY: { value: "http://p:3128" },
  });
  expect(existsSync(legacy)).toBe(false);
  expect(existsSync(`${legacy}.migrated`)).toBe(true);
});
