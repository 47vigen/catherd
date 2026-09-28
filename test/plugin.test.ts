import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const root = join(import.meta.dir, "..");
const readJson = (base: string, p: string) => JSON.parse(readFileSync(join(base, p), "utf8"));
const LAUNCHER = join(root, "plugin", "bin", "catherd-mcp");
const stampedIn = (text: string) => /^VERSION="([^"]+)"$/m.exec(text)?.[1];

describe("plugin", () => {
  it("the marketplace serves the plugin folder over HTTPS from the package version's release tag", () => {
    const m = readJson(root, ".claude-plugin/marketplace.json");
    const { version } = readJson(root, "package.json");
    expect(m.name).toBe("catherd");
    expect(m.owner.name).toBeTruthy();
    const entry = m.plugins.find((p: { name: string }) => p.name === "catherd");
    // a full HTTPS URL: the `owner/repo` shorthand clones over SSH, which fails without a GitHub SSH key
    expect(entry.source).toEqual({
      source: "git-subdir",
      url: "https://github.com/47vigen/catherd.git",
      path: "plugin",
      ref: `v${version}`,
    });
    expect(entry.version).toBeUndefined();
    expect(existsSync(join(root, entry.source.path, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("pins the package version in the manifest, and starts the MCP server through the stamped launcher", () => {
    const { version } = readJson(root, "package.json");
    expect(readJson(root, "plugin/.claude-plugin/plugin.json")).toMatchObject({ name: "catherd", version });
    expect(readJson(root, "plugin/.mcp.json")).toEqual({
      mcpServers: { catherd: { command: "sh", args: ["${CLAUDE_PLUGIN_ROOT}/bin/catherd-mcp"] } },
    });
    const launcher = readFileSync(LAUNCHER, "utf8");
    expect(launcher.startsWith("#!/bin/sh\n")).toBe(true);
    expect(stampedIn(launcher)).toBe(version);
    expect(statSync(LAUNCHER).mode & 0o111).not.toBe(0);
  });

  it("the stamp script writes a new version into every pinned file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "catherd-stamp-"));
    for (const p of ["package.json", "plugin", "scripts", ".claude-plugin"]) {
      cpSync(join(root, p), join(tmp, p), { recursive: true });
    }
    const pkg = readJson(tmp, "package.json");
    writeFileSync(join(tmp, "package.json"), JSON.stringify({ ...pkg, version: "9.9.9" }));
    const proc = Bun.spawnSync(["bun", join(tmp, "scripts", "stamp-plugin-version.mjs")], {
      env: { PATH: process.env.PATH ?? "", HOME: tmp },
    });
    expect(proc.success).toBe(true);
    expect(readJson(tmp, "plugin/.claude-plugin/plugin.json").version).toBe("9.9.9");
    expect(stampedIn(readFileSync(join(tmp, "plugin", "bin", "catherd-mcp"), "utf8"))).toBe("9.9.9");
    expect(readJson(tmp, "plugin/.mcp.json")).toEqual(readJson(root, "plugin/.mcp.json"));
    expect(readJson(tmp, ".claude-plugin/marketplace.json").plugins[0].source.ref).toBe("v9.9.9");
    const skill = readFileSync(join(tmp, "plugin", "skills", "catherd", "SKILL.md"), "utf8");
    const pins = [...skill.matchAll(/catherd-cli@([^\s`)"]+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins)).toEqual(new Set(["9.9.9"]));
  });

  it("each command hands its arguments to its skill", () => {
    for (const [cmd, skill] of [
      ["catherd", "catherd"],
      ["catherd-setup", "catherd-setup"],
    ] as const) {
      const md = readFileSync(join(root, "plugin", "commands", `${cmd}.md`), "utf8");
      expect(md).toMatch(/^---\ndescription: .+\nargument-hint: .+\n---\n/);
      expect(md).toContain(`\`${skill}\` skill`);
      expect(md).toContain("$ARGUMENTS");
    }
  });
});

describe("the MCP launcher, plugin/bin/catherd-mcp (spec 1.1 §12)", () => {
  const version = stampedIn(readFileSync(LAUNCHER, "utf8")) as string;

  /** A folder of fake `catherd` and `bunx` that print what they were run with instead of starting anything. */
  function fakes(catherdVersion: string | null): { bin: string; home: string } {
    const dir = mkdtempSync(join(tmpdir(), "catherd-launcher-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    if (catherdVersion !== null)
      script(
        "catherd",
        `if [ "$1" = --version ]; then echo "${catherdVersion}"; exit 0; fi\necho "catherd $*"\necho "TMPDIR=\${TMPDIR-unset}"\necho "USER_TMPDIR=\${CATHERD_USER_TMPDIR-unset}"`,
      );
    script(
      "bunx",
      'echo "bunx $*"\necho "TMPDIR=$TMPDIR"\necho "USER_TMPDIR=${CATHERD_USER_TMPDIR-unset}"\n[ -d "$TMPDIR" ] && echo "dir exists"',
    );
    return { bin, home: join(dir, "home") };
  }

  const launch = (bin: string, env: Record<string, string>) => {
    const p = Bun.spawnSync(["sh", LAUNCHER], {
      env: { PATH: `${bin}:/usr/bin:/bin`, ANTHROPIC_API_KEY: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString().trim().split("\n"), err: p.stderr.toString() };
  };

  it("runs the global catherd when it is the stamped version, and leaves TMPDIR alone", () => {
    const { bin, home } = fakes(version);
    expect(launch(bin, { HOME: home, TMPDIR: "/tmp/mine" })).toMatchObject({
      code: 0,
      out: ["catherd mcp", "TMPDIR=/tmp/mine", "USER_TMPDIR=unset"],
    });
  });

  it("drops a stray inherited CATHERD_USER_TMPDIR before it runs the global catherd", () => {
    const { bin, home } = fakes(version);
    expect(launch(bin, { HOME: home, TMPDIR: "/tmp/mine", CATHERD_USER_TMPDIR: "/tmp/stale" })).toMatchObject(
      {
        code: 0,
        out: ["catherd mcp", "TMPDIR=/tmp/mine", "USER_TMPDIR=unset"],
      },
    );
  });

  it("falls back to bunx when the catherd on PATH does not answer --version", () => {
    const { bin, home } = fakes(null);
    writeFileSync(join(bin, "catherd"), "#!/bin/sh\nexit 3\n");
    chmodSync(join(bin, "catherd"), 0o755);
    expect(launch(bin, { HOME: home }).out[0]).toBe(`bunx catherd-cli@${version} mcp`);
  });

  it("stops with a message, before bunx, when neither HOME nor XDG_CACHE_HOME is set", () => {
    const { bin } = fakes(null);
    const r = launch(bin, {});
    expect(r.code).not.toBe(0);
    expect(r.out).toEqual([""]);
    expect(r.err).toContain("catherd-mcp: HOME and XDG_CACHE_HOME are both unset");
  });

  it("stops with a message, before bunx, when it cannot make the bunx cache folder", () => {
    const { bin, home } = fakes(null);
    mkdirSync(home, { recursive: true });
    const file = join(home, "a-file");
    writeFileSync(file, "");
    const r = launch(bin, { HOME: home, XDG_CACHE_HOME: file });
    expect(r.code).not.toBe(0);
    expect(r.out).toEqual([""]);
    expect(r.err).toContain(`catherd-mcp: cannot create ${file}/catherd/bunx`);
  });

  it("falls back to bunx at the stamped version, with TMPDIR in catherd's cache and the user's own kept", () => {
    const { bin, home } = fakes("0.0.1");
    const cache = join(home, "xdg-cache");
    expect(launch(bin, { HOME: home, TMPDIR: "/tmp/mine", XDG_CACHE_HOME: cache })).toMatchObject({
      code: 0,
      out: [
        `bunx catherd-cli@${version} mcp`,
        `TMPDIR=${cache}/catherd/bunx`,
        "USER_TMPDIR=/tmp/mine",
        "dir exists",
      ],
    });
  });

  it("uses ~/.cache without XDG_CACHE_HOME, and falls back when no catherd is on PATH", () => {
    const { bin, home } = fakes(null);
    expect(launch(bin, { HOME: home })).toMatchObject({
      code: 0,
      out: [
        `bunx catherd-cli@${version} mcp`,
        `TMPDIR=${home}/.cache/catherd/bunx`,
        "USER_TMPDIR=",
        "dir exists",
      ],
    });
  });
});
