/**
 * Spec §12's npm pack smoke: packs catherd, installs the tarball into an empty project and runs what a user
 * runs first, `catherd --version` and `catherd doctor --json`, whose `mcp` row is the MCP initialize and
 * tools/list handshake against the installed server. Not a `bun test` file: CI's package job runs it with
 * `bun test/pack-smoke.ts`. It needs the npm registry, to install the package's dependencies.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { scrubSecrets } from "../src/infra/env.ts";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name: string; version: string };
const work = mkdtempSync(join(tmpdir(), "catherd-pack-"));

/** What the package needs at runtime: the CLI and the supervisor entry, the shipped catalog, the plugin. */
const SHIPPED = [
  "package.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "src/cli.ts",
  "src/entry/supervise-bin.ts",
  "catalog/models.json",
  "catalog/scores.json",
  "catalog/jev.json",
  "catalog/sources.json",
  "catalog/ATTRIBUTION.md",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.mcp.json",
  "plugin/.codex-plugin/plugin.json",
  "plugin/.mcp-codex.json",
  "plugin/skills/catherd/SKILL.md",
  "plugin/skills/catherd-setup/SKILL.md",
  "plugin/bin/catherd-mcp",
];

function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(cmd, {
    cwd,
    env: scrubSecrets({ ...process.env, ...env }),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
}

function must(ok: boolean, what: string, detail = ""): void {
  if (!ok) {
    console.error(`pack smoke failed: ${what}${detail ? `\n${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`ok  ${what}`);
}

// 1. the tarball holds what catherd needs at runtime, and none of the repository's own files
const packed = run([process.execPath, "pm", "pack", "--destination", work], ROOT);
must(packed.code === 0, "bun pm pack", packed.err);
const tgz = join(work, `${pkg.name}-${pkg.version}.tgz`);
const files = run(["tar", "-tzf", tgz], work).out.split("\n");
for (const f of SHIPPED) must(files.includes(`package/${f}`), `the tarball has ${f}`);
must(
  !files.some((f) => /^package\/(test|docs|scripts|\.github|\.changeset)\//.test(f)),
  "the tarball has no tests, docs, scripts or CI files",
);

// 2. it installs into an empty project
const app = join(work, "app");
mkdirSync(app);
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "catherd-pack-smoke", private: true }));
const added = run([process.execPath, "add", tgz], app);
must(added.code === 0, "bun add <tarball>", added.err);

// 3. it runs in a fresh home, with no backend login and no Jev key needed
const bin = join(app, "node_modules", ".bin", "catherd");
const home = join(work, "home");
// the installed bin on PATH, as after `bun add -g`: doctor's `mcp` row starts the server through the
// plugin's launcher, which runs this catherd because it prints the launcher's version
const env = {
  // No provider CLI is needed for this offline handshake; isolate their native configuration too.
  PATH: `${join(app, "node_modules", ".bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home,
  CODEX_HOME: join(home, "codex"),
  CATHERD_HOME: home,
  CLAUDE_CONFIG_DIR: join(home, "claude"),
  CATHERD_CLAUDE_AGENTS_DIR: join(home, "claude-agents"),
  TYPESAFE_API_KEY: "",
  ARTIFICIAL_ANALYSIS_API_KEY: "",
  ANTHROPIC_API_KEY: "",
  // the server doctor starts would sync the public sources in the background (spec 1.2 §3.2): not here
  CATHERD_NO_SYNC: "1",
  // run() scrubs all parent host/session identity before every child, including overrides.
};
const version = run([bin, "--version"], app, env);
must(
  version.out.trim() === pkg.version,
  `catherd --version prints ${pkg.version}`,
  version.out + version.err,
);
const doctor = run([bin, "doctor", "--host", "codex", "--json"], app, env);
must(
  doctor.code === 0 || doctor.code === 3,
  "catherd doctor --host codex --json exits 0 or 3 (not ready)",
  doctor.err,
);
const report = JSON.parse(doctor.out) as { version: string; checks: { id: string; state: string }[] };
must(report.version === pkg.version, "doctor reports the installed version");
const mcp = report.checks.find((c) => c.id === "mcp");
must(mcp?.state === "ok", "the installed MCP server answers initialize and tools/list", JSON.stringify(mcp));

must(
  !existsSync(join(home, ".claude")) &&
    !existsSync(env.CLAUDE_CONFIG_DIR) &&
    !existsSync(env.CATHERD_CLAUDE_AGENTS_DIR),
  "Codex-only pack smoke creates no Claude configuration or agent files",
);
console.log(
  JSON.stringify({
    packageVersion: pkg.version,
    tarball: tgz,
    tarballSha256: createHash("sha256").update(readFileSync(tgz)).digest("hex"),
    core: realpathSync(bin),
    coreSha256: createHash("sha256")
      .update(readFileSync(realpathSync(bin)))
      .digest("hex"),
    host: "codex",
    session: null,
  }),
);
