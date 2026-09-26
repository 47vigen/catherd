import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Spec §11.6's PTY smoke test: the real binary in a real terminal (tmux, 80×24) with an isolated home,
 * driven by real keys. It is the one TUI test on wall-clock time, so it waits on what the screen shows,
 * with a deadline, never on a fixed sleep.
 */
const TMUX = Bun.which("tmux");
const CLI = join(import.meta.dir, "..", "..", "..", "src", "cli.ts");
const sessions: string[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) Bun.spawnSync([TMUX as string, "kill-session", "-t", s]);
});

const tmux = (...args: string[]) =>
  new TextDecoder().decode(Bun.spawnSync([TMUX as string, ...args], { env: process.env }).stdout);

async function until(what: string, f: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

async function start(args: string) {
  const home = mkdtempSync(join(tmpdir(), "catherd-pty-"));
  const name = `catherd-${process.pid}-${sessions.length}`;
  sessions.push(name);
  const env = [
    `CATHERD_HOME=${home}`,
    `CATHERD_CLAUDE_AGENTS_DIR=${join(home, "agents")}`,
    `CLAUDE_CONFIG_DIR=${join(home, "claude")}`,
    // no backend CLI on PATH: doctor answers fast, and nothing real is touched
    `PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
    "TERM=xterm-256color",
    "LANG=C.UTF-8",
  ].join(" ");
  tmux(
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    "80",
    "-y",
    "24",
    // outside the catherd checkout, so no repo binding decides the profile
    "-c",
    home,
    `env ${env} ${process.execPath} ${CLI} ${args}; echo $? > ${home}/exit; sleep 60`,
  );
  const screen = () => tmux("capture-pane", "-p", "-t", name);
  const keys = async (...k: string[]) => {
    for (const x of k) tmux("send-keys", "-t", name, x);
  };
  return { home, screen, keys };
}

describe.skipIf(!TMUX)("the TUI in a real terminal", () => {
  it("stages an edit, saves it from the dialog, quits 0, and prints what to keep after exit", async () => {
    const t = await start("");
    await until("the status tab", () => t.screen().includes("SETUP"));
    await t.keys("2");
    await until("the profiles tab", () => t.screen().includes("ROLES"));
    await t.keys("j", "Space");
    await until("the staged change", () => t.screen().includes("1 unsaved"));
    await t.keys("C-s");
    await until("the save dialog", () => t.screen().includes("Save profile default"));
    await t.keys("Enter");
    await until("the save", () => !t.screen().includes("unsaved"));
    await t.keys("q");
    await until("the exit", () => existsSync(join(t.home, "exit")));
    expect(readFileSync(join(t.home, "exit"), "utf8").trim()).toBe("0");
    // the alternate screen is gone and the line to keep is on the terminal (spec §9.4)
    expect(t.screen()).not.toContain("SETUP");
    expect(t.screen()).toContain(
      "catherd: start a new Claude Code session to use: catherd-default-architect",
    );
    const profile = JSON.parse(readFileSync(join(t.home, "config", "profiles", "default.json"), "utf8"));
    expect(profile.roles.verifier.enabled).toBe(false);
  }, 60_000);

  it("opens `catherd watch` on the Runs tab", async () => {
    const t = await start("watch");
    await until("the runs tab", () => t.screen().includes("No runs yet"));
    await t.keys("q");
    await until("the exit", () => existsSync(join(t.home, "exit")));
    expect(readFileSync(join(t.home, "exit"), "utf8").trim()).toBe("0");
  }, 60_000);

  it("exits 130 when unsaved changes are discarded with ctrl+c twice", async () => {
    const t = await start("");
    await until("the status tab", () => t.screen().includes("SETUP"));
    await t.keys("2");
    await until("the profiles tab", () => t.screen().includes("ROLES"));
    await t.keys("j", "Space");
    await until("the staged change", () => t.screen().includes("1 unsaved"));
    await t.keys("C-c", "C-c");
    await until("the exit", () => existsSync(join(t.home, "exit")));
    expect(readFileSync(join(t.home, "exit"), "utf8").trim()).toBe("130");
    expect(existsSync(join(t.home, "config", "profiles", "default.json"))).toBe(false);
  }, 60_000);
});
