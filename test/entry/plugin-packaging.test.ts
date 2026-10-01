import { afterAll, describe, expect, it } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { scrubSecrets } from "../../src/infra/env.ts";

const ROOT = join(import.meta.dir, "../..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const readJson = (root: string, path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const dirs: string[] = [];
const temporary = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

it("shared_version_pin keeps both native manifests and the shared launcher on the package version", () => {
  const native = readJson(ROOT, "plugin/.codex-plugin/plugin.json");
  expect(native).toMatchObject({
    name: "catherd",
    version: pkg.version,
    skills: "./skills/",
    mcpServers: "./.mcp-codex.json",
  });
  expect(readJson(ROOT, "plugin/.claude-plugin/plugin.json").version).toBe(pkg.version);
  expect(readFileSync(join(ROOT, "plugin/bin/catherd-mcp"), "utf8")).toContain(`VERSION="${pkg.version}"`);
  expect(readJson(ROOT, "plugin/.mcp-codex.json")).toEqual({
    mcpServers: {
      catherd: {
        command: "sh",
        args: ["./bin/catherd-mcp"],
        cwd: ".",
        env: { CATHERD_ORCHESTRATION_HOST: "codex" },
      },
    },
  });
  expect(readJson(ROOT, "plugin/.mcp.json").mcpServers.catherd.args).toEqual([
    "${CLAUDE_PLUGIN_ROOT}/bin/catherd-mcp",
  ]);
});

it("stamps both integrations together in a disposable fixture without changing their launch contract", () => {
  const dir = temporary("catherd-native-stamp-");
  for (const p of ["package.json", "plugin", "scripts", ".claude-plugin"])
    cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  const before = readJson(dir, "plugin/.mcp-codex.json");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ ...pkg, version: "9.9.9" }));
  const p = Bun.spawnSync([process.execPath, join(dir, "scripts/stamp-plugin-version.mjs")], {
    env: { PATH: process.env.PATH ?? "", HOME: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(p.exitCode).toBe(0);
  expect(readJson(dir, "plugin/.codex-plugin/plugin.json").version).toBe("9.9.9");
  expect(readJson(dir, "plugin/.claude-plugin/plugin.json").version).toBe("9.9.9");
  expect(readFileSync(join(dir, "plugin/bin/catherd-mcp"), "utf8")).toContain('VERSION="9.9.9"');
  expect(readJson(dir, "plugin/.mcp-codex.json")).toEqual(before);
  expect(readJson(dir, ".claude-plugin/marketplace.json").plugins[0].source.ref).toBe("v9.9.9");
});

it("shared_version_pin rejects a mismatched global CLI and invokes the exact pinned package without network", () => {
  const dir = temporary("catherd native pin with spaces ");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const script = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  script("catherd", 'if [ "$1" = --version ]; then echo 0.0.1; exit 0; fi\necho unexpected-global; exit 90');
  script("bunx", 'printf "%s\\n" "$@"');
  const p = Bun.spawnSync(["sh", join(ROOT, "plugin/bin/catherd-mcp")], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, CATHERD_ORCHESTRATION_HOST: "codex" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toBe(`catherd-cli@${pkg.version}\nmcp\n`);
});

// Opt-in installed native parser/launcher proof. This starts no app-server/model turn and sends no queue input.
// Run: CATHERD_TEST_NATIVE_PLUGIN=1 bun test test/entry/plugin-packaging.test.ts
// A skip is not runtime/root evidence; packaged live acceptance remains a separate owner gate.
describe.skipIf(process.env.CATHERD_TEST_NATIVE_PLUGIN !== "1")("installed native plugin runtime", () => {
  it("native_root_with_spaces resolves its installed root and initializes the shared launcher", async () => {
    const codex = Bun.which("codex");
    expect(codex).not.toBeNull();
    const dir = temporary("catherd native runtime with spaces ");
    const marketplace = join(dir, "local marketplace");
    const plugin = join(marketplace, "plugin with spaces");
    cpSync(join(ROOT, "plugin"), plugin, { recursive: true });
    mkdirSync(join(marketplace, ".agents/plugins"), { recursive: true });
    writeFileSync(
      join(marketplace, ".agents/plugins/marketplace.json"),
      JSON.stringify({
        name: "catherd-runtime-evidence",
        owner: { name: "local-evidence" },
        plugins: [{ name: "catherd", source: "./plugin with spaces" }],
      }),
    );
    const home = join(dir, "home");
    const nativeHome = join(dir, "native config");
    const bin = join(dir, "local bin");
    for (const p of [home, nativeHome, bin]) mkdirSync(p, { recursive: true });
    const core = join(ROOT, "src/cli.ts");
    const trace = join(dir, "core-trace.jsonl");
    writeFileSync(
      join(bin, "catherd"),
      `#!${process.execPath}\nimport {appendFileSync} from "node:fs";\nappendFileSync(${JSON.stringify(trace)},JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),core:${JSON.stringify(core)},host:process.env.CATHERD_ORCHESTRATION_HOST})+"\\n");\nconst p=Bun.spawn([process.execPath,${JSON.stringify(core)},...process.argv.slice(2)],{env:process.env,stdin:"inherit",stdout:"inherit",stderr:"inherit"});\nprocess.exit(await p.exited);\n`,
      { mode: 0o755 },
    );
    const env = {
      ...scrubSecrets(process.env),
      HOME: home,
      CODEX_HOME: nativeHome,
      CATHERD_HOME: join(dir, "catherd home"),
      CLAUDE_CONFIG_DIR: join(dir, "isolated claude"),
      CATHERD_CLAUDE_AGENTS_DIR: join(dir, "isolated agents"),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CATHERD_NO_SYNC: "1",
      ANTHROPIC_API_KEY: "",
    };
    const run = (args: string[]) => {
      const p = Bun.spawnSync([codex!, ...args], {
        env,
        cwd: home,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 25_000,
      });
      expect(p.stderr.toString()).toBe("");
      expect(p.exitCode).toBe(0);
      return JSON.parse(p.stdout.toString());
    };
    run(["plugin", "marketplace", "add", marketplace, "--json"]);
    const installed = run(["plugin", "add", "catherd@catherd-runtime-evidence", "--json"])
      .installedPath as string;
    const servers = run(["mcp", "list", "--json"]) as {
      name: string;
      transport: { command: string; args: string[]; env: Record<string, string>; cwd: string };
    }[];
    expect(servers).toHaveLength(1);
    const selected = servers.find((s) => s.name === "catherd")!;
    const config = selected.transport;
    const resolved = realpathSync(join(config.cwd, config.args[0]!));
    expect(resolved).toBe(realpathSync(join(installed, "bin/catherd-mcp")));
    expect(hash(resolved)).toBe(hash(join(ROOT, "plugin/bin/catherd-mcp")));
    expect(config).toMatchObject({
      command: "sh",
      args: ["./bin/catherd-mcp"],
      env: { CATHERD_ORCHESTRATION_HOST: "codex" },
    });
    expect(config.env.CODEX_THREAD_ID).toBeUndefined();
    expect(config.env.CODEX_SESSION_ID).toBeUndefined();
    const client = new Client({ name: "codex-mcp-client", version: "native-root-evidence" });
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: { ...env, ...config.env },
      stderr: "ignore",
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.some((t) => t.name === "status")).toBe(true);
      const result = await client.callTool({ name: "profile_get", arguments: {} });
      const data =
        result.structuredContent ??
        JSON.parse((result.content as { type: string; text: string }[]).find((x) => x.type === "text")!.text);
      const profile = (
        data as { profile: { roles: { architect: { rungs: string[] }; verifier: { rungs: string[] } } } }
      ).profile;
      expect(profile.roles.architect.rungs).toEqual(["codex:gpt-6.1-sol#high"]);
      expect(profile.roles.verifier.rungs).toEqual(["codex:gpt-6.1-sol#low"]);
      const calls = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(
        calls.some(
          (c) =>
            c.args[0] === "mcp" &&
            c.core === core &&
            realpathSync(c.cwd) === realpathSync(installed) &&
            c.host === "codex",
        ),
      ).toBe(true);
      expect(existsSync(env.CLAUDE_CONFIG_DIR)).toBe(false);
      expect(existsSync(env.CATHERD_CLAUDE_AGENTS_DIR)).toBe(false);
      console.log(
        JSON.stringify({
          evidence: "native root feasibility; not packaged live acceptance",
          nativeCli: codex,
          installedPluginRoot: installed,
          resolvedLauncher: resolved,
          launcherSha256: hash(resolved),
          core,
          coreSha256: hash(core),
          initialize: true,
          toolsList: true,
          toolCount: tools.tools.length,
          host: "codex",
          session: null,
        }),
      );
    } finally {
      await client.close();
    }
  }, 60_000);
});
