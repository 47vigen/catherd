import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writableRoots } from "../../src/adapters/access.ts";
import {
  grokAccess,
  grokHomeEnv,
  grokHost,
  isolatedGrokRoot,
  READ_TOOLS,
  userGrokHome,
  withCatherdProfiles,
  writeGrokProfiles,
} from "../../src/adapters/grok/home.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { configDir, dataDir } from "../../src/infra/paths.ts";
import { snapshotEnv, tempDir, withHome } from "../helpers.ts";

afterEach(snapshotEnv());
const host = { ...grokHost };
afterEach(() => Object.assign(grokHost, host));

const BLOCK = (roots: string[]) =>
  [
    "# >>> catherd's sandbox profiles for its grok workers: catherd rewrites this block, so edit outside it",
    "[profiles.catherd-ws]",
    'extends = "workspace"',
    `read_write = [${roots.map((r) => JSON.stringify(r)).join(", ")}]`,
    "",
    "[profiles.catherd-ws-offline]",
    'extends = "workspace"',
    `read_write = [${roots.map((r) => JSON.stringify(r)).join(", ")}]`,
    "restrict_network = true",
    "# <<< catherd",
    "",
  ].join("\n");

describe("grok's isolated home (spec 1.3 §5.4)", () => {
  it("moves HOME and GROK_HOME to catherd's, turns the ten Claude and Cursor toggles and memory off", () => {
    withHome();
    const env = grokHomeEnv();
    expect(env).toMatchObject({
      HOME: isolatedGrokRoot(),
      GROK_HOME: join(isolatedGrokRoot(), ".grok"),
      GROK_MEMORY: "0",
      GROK_CLAUDE_HOOKS_ENABLED: "0",
      GROK_CURSOR_MCPS_ENABLED: "0",
      CATHERD_CONFIG_DIR: configDir(),
      CATHERD_DATA_DIR: dataDir(),
    });
    expect(Object.keys(env).filter((k) => /^GROK_(CLAUDE|CURSOR)_\w+_ENABLED$/.test(k))).toHaveLength(10);
    expect(existsSync(isolatedGrokRoot())).toBe(false); // computing it creates nothing
  });

  it("reads the user's GROK_HOME, else ~/.grok", () => {
    process.env.GROK_HOME = "/somewhere/.grok";
    expect(userGrokHome()).toBe("/somewhere/.grok");
    delete process.env.GROK_HOME;
    expect(userGrokHome()).toEndWith("/.grok");
  });
});

describe("grok access flags (spec 1.3 §5.3)", () => {
  it("maps each access to a sandbox profile, catherd-ws for workspace-write, offline without network", () => {
    grokHost.platform = "linux";
    expect(grokAccess("full")).toEqual(["--sandbox", "off"]);
    expect(grokAccess("workspace-write")).toEqual(["--sandbox", "catherd-ws"]);
    expect(grokAccess("workspace-write", false)).toEqual(["--sandbox", "catherd-ws-offline"]);
    expect(grokAccess("read-only")).toEqual(["--sandbox", "read-only"]);
  });

  it("runs read-only as a read tool allowlist on a Mac whose docker socket is a symlink", () => {
    const dir = tempDir("catherd-sock-");
    writeFileSync(join(dir, "real.sock"), "");
    symlinkSync(join(dir, "real.sock"), join(dir, "docker.sock"));
    Object.assign(grokHost, { platform: "darwin", dockerSocket: join(dir, "docker.sock") });
    expect(grokAccess("read-only")).toEqual(["--sandbox", "workspace", "--tools", READ_TOOLS]);
    expect(READ_TOOLS).toBe("read_file,grep,list_dir,web_search,web_fetch");
    grokHost.dockerSocket = join(dir, "real.sock"); // a socket that is no link: the kernel profile applies
    expect(grokAccess("read-only")).toEqual(["--sandbox", "read-only"]);
    grokHost.dockerSocket = join(dir, "none.sock"); // no Docker at all
    expect(grokAccess("read-only")).toEqual(["--sandbox", "read-only"]);
  });
});

describe("catherd's tables in a sandbox.toml (spec 1.3 §5.3, §9 Q3)", () => {
  it("writes only catherd's marked block, catherd's writable roots in it", () => {
    withHome();
    expect(withCatherdProfiles("")).toEqual({ text: BLOCK(writableRoots()) });
  });

  it("keeps the user's tables byte for byte, and replaces its own block in place on a rewrite", () => {
    const mine = '# mine\n[profiles.dev]\nextends = "devbox"\nread_write = ["/data/x"]\n';
    const once = withCatherdProfiles(mine, { "catherd-ws": { extends: "workspace", read_write: ["/a"] } });
    expect(once).toEqual({
      text: `${mine}\n# >>> catherd's sandbox profiles for its grok workers: catherd rewrites this block, so edit outside it\n[profiles.catherd-ws]\nextends = "workspace"\nread_write = ["/a"]\n# <<< catherd\n`,
    });
    const text = "text" in once ? once.text : "";
    const after = `${text}[profiles.late]\nextends = "strict"\n`;
    const twice = withCatherdProfiles(after, { "catherd-ws": { extends: "workspace", read_write: ["/b"] } });
    // rewritten where it stands (1.3 follow-ups); /a no longer exists, so it does not stay
    expect("text" in twice && twice.text).toBe(
      `${mine}\n# >>> catherd's sandbox profiles for its grok workers: catherd rewrites this block, so edit outside it\n[profiles.catherd-ws]\nextends = "workspace"\nread_write = ["/b"]\n# <<< catherd\n[profiles.late]\nextends = "strict"\n`,
    );
    expect(Bun.TOML.parse("text" in twice ? twice.text : "")).toMatchObject({
      profiles: {
        dev: { extends: "devbox" },
        late: { extends: "strict" },
        "catherd-ws": { read_write: ["/b"] },
      },
    });
  });

  it("keeps a bare key after the block in the table it was in, and two catherd homes' roots in one block", () => {
    const a = tempDir("catherd-root-a-");
    const b = tempDir("catherd-root-b-");
    const ws = (roots: string[]) => ({ "catherd-ws": { extends: "workspace", read_write: roots } });
    const first = withCatherdProfiles('[profiles.dev]\nextends = "devbox"\n', ws([a]));
    const text = `${"text" in first ? first.text : ""}note = "mine"\n`;
    const before = Bun.TOML.parse(text) as { profiles: Record<string, Record<string, unknown>> };
    // another catherd home rewrites the block: its roots join ours, and the user's key stays where it was
    const second = withCatherdProfiles(text, ws([b]));
    const out = "text" in second ? second.text : "";
    const parsed = Bun.TOML.parse(out) as { profiles: Record<string, Record<string, unknown>> };
    expect(parsed.profiles["catherd-ws"]).toEqual({ ...before.profiles["catherd-ws"], read_write: [a, b] });
    expect(parsed.profiles.dev).toEqual(before.profiles.dev);
    // and the first home finds nothing to change: no back-and-forth
    expect(withCatherdProfiles(out, ws([a]))).toEqual({ text: out });
  });

  it("refuses a file that is not TOML, a catherd- profile of the user's own, and a lost block marker", () => {
    expect(withCatherdProfiles("[profiles\n")).toMatchObject({
      why: expect.stringContaining("not valid TOML"),
    });
    expect(withCatherdProfiles('[profiles.catherd-ws]\nextends = "off"\n')).toEqual({
      why: "it has a [profiles.catherd-ws] of its own: rename it, catherd's tables are catherd-*",
    });
    expect(withCatherdProfiles("# >>> catherd's sandbox profiles for its grok workers\n")).toEqual({
      why: "catherd's block has lost its end marker (# <<< catherd): delete the block",
    });
    // an inline `profiles` table cannot take another table
    expect(withCatherdProfiles('profiles = { dev = { extends = "devbox" } }\n')).toMatchObject({
      why: expect.stringContaining("not valid TOML"),
    });
  });

  it("writes the file keeping its mode, and refuses to touch one it must not, with the fix", () => {
    withHome();
    const home = tempDir("catherd-grokhome-");
    const file = join(home, "sandbox.toml");
    writeFileSync(file, '[profiles.dev]\nextends = "devbox"\n');
    chmodSync(file, 0o644);
    writeGrokProfiles(home);
    expect(readFileSync(file, "utf8")).toStartWith('[profiles.dev]\nextends = "devbox"\n\n# >>> catherd');
    expect(statSync(file).mode & 0o777).toBe(0o644);
    const fresh = tempDir("catherd-grokhome-");
    writeGrokProfiles(join(fresh, ".grok")); // grok never ran here: its home is made
    expect(readFileSync(join(fresh, ".grok", "sandbox.toml"), "utf8")).toBe(BLOCK(writableRoots()));
    writeFileSync(file, "[profiles\n");
    let err: unknown;
    try {
      writeGrokProfiles(home);
    } catch (e) {
      err = e;
    }
    expect(isCatherdError(err) && [err.code, err.message, err.fix]).toEqual([
      "E_CONFIG_INVALID",
      expect.stringContaining(`catherd will not edit ${file}: it is not valid TOML`),
      `fix ${file}, or isolate grok (catherd profile set harness.grok.isolated true)`,
    ]);
    expect(readFileSync(file, "utf8")).toBe("[profiles\n");
  });
});

describe("a sandbox.toml that is a link (plan 16 final review, Important 1)", () => {
  it("writes through the link, keeping it and the user's file it points at", () => {
    const home = tempDir("catherd-grok-link-");
    const dotfiles = tempDir("catherd-dotfiles-");
    const target = join(dotfiles, "sandbox.toml");
    writeFileSync(target, '[profiles.mine]\nextends = "workspace"\n');
    symlinkSync(target, join(home, "sandbox.toml"));
    writeGrokProfiles(home);
    expect(lstatSync(join(home, "sandbox.toml")).isSymbolicLink()).toBe(true);
    const text = readFileSync(target, "utf8");
    expect(text).toContain("[profiles.mine]");
    expect(text).toContain("catherd-ws");
  });

  it("refuses a link it cannot follow or a file it cannot write with E_CONFIG_INVALID and the isolate fix", () => {
    withHome();
    const refusal = (home: string) => {
      try {
        writeGrokProfiles(home);
      } catch (e) {
        return isCatherdError(e) ? [e.code, e.message, e.fix] : [String(e)];
      }
      return ["wrote"];
    };
    const dangling = tempDir("catherd-grok-dangling-");
    symlinkSync(join(dangling, "gone", "sandbox.toml"), join(dangling, "sandbox.toml"));
    expect(refusal(dangling)).toEqual([
      "E_CONFIG_INVALID",
      `catherd will not edit ${join(dangling, "sandbox.toml")}: it is a link catherd cannot follow (ENOENT)`,
      `fix ${join(dangling, "sandbox.toml")}, or isolate grok (catherd profile set harness.grok.isolated true)`,
    ]);
    // a link to something that is not a file
    const odd = tempDir("catherd-grok-odd-");
    symlinkSync(tempDir("catherd-grok-dir-"), join(odd, "sandbox.toml"));
    expect(refusal(odd)[0]).toBe("E_CONFIG_INVALID");
    expect(refusal(odd)[1]).toEndWith(": catherd cannot read it (EISDIR)");
    // a link into a read-only store: catherd's atomic write cannot replace the file there
    const store = tempDir("catherd-grok-store-");
    writeFileSync(join(store, "sandbox.toml"), "");
    chmodSync(store, 0o555);
    const home = tempDir("catherd-grok-ro-");
    symlinkSync(join(store, "sandbox.toml"), join(home, "sandbox.toml"));
    try {
      const [code, message] = refusal(home);
      // root writes anywhere: then the write goes through, as it would for that user
      if (code !== "wrote") {
        expect(code).toBe("E_CONFIG_INVALID");
        expect(message).toMatch(/: catherd cannot write it \(E[A-Z]+\)$/);
      }
    } finally {
      chmodSync(store, 0o755);
    }
  });
});
