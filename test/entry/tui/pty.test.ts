import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Spec §11.6's PTY smoke test: the real binary in a real terminal (tmux, 80×24) with an isolated home,
 * driven by real keys. It is the one TUI test on wall-clock time, so it waits on what the screen shows,
 * with a deadline, never on a fixed sleep.
 */
const TMUX = Bun.which("tmux");
const CLI = join(import.meta.dir, "..", "..", "..", "src", "cli.ts");
// a private tmux server with no config: never the developer's server, its environment or ~/.tmux.conf;
// its socket lives in a temp dir this file removes, since tmux leaves the socket file behind
const SOCKET_DIR = mkdtempSync(join(tmpdir(), "catherd-pty-tmux-"));
const SOCKET = join(SOCKET_DIR, "tmux");
const tmux = (...args: string[]) =>
  new TextDecoder().decode(
    Bun.spawnSync([TMUX as string, "-S", SOCKET, "-f", "/dev/null", ...args], { env: process.env }).stdout,
  );
afterEach(() => {
  tmux("kill-server");
});
// every case's home, removed with the socket once the file is done
const homes: string[] = [];
afterAll(() => {
  for (const d of [SOCKET_DIR, ...homes]) rmSync(d, { recursive: true, force: true });
});
let started = 0;

async function until(what: string, f: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

async function start(args: string) {
  const home = mkdtempSync(join(tmpdir(), "catherd-pty-"));
  homes.push(home);
  const name = `catherd-${started++}`;
  // `env -i`: the binary sees only these, whatever the test runner or the tmux server has
  const env = [
    `HOME=${home}`,
    `CATHERD_HOME=${home}`,
    `CATHERD_CLAUDE_AGENTS_DIR=${join(home, "agents")}`,
    `CLAUDE_CONFIG_DIR=${join(home, "claude")}`,
    // no backend CLI on PATH: doctor answers fast, and nothing real is touched
    `PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
    "TERM=xterm-256color",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    // no key: doctor's discovery never reaches the Models API
    "ANTHROPIC_API_KEY=",
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
    `env -i ${env} ${process.execPath} ${CLI} ${args}; echo $? > ${home}/exit; sleep 60`,
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
    // the buttons show once the preview is read: enter saves only after the diff is shown
    await until("the save dialog", () => t.screen().includes("[ Save ]"));
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
