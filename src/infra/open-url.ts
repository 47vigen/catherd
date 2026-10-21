import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A page that sends the browser on to `url`, so the opener's argv (readable by every local user, and kept in
 * /proc/<pid>/cmdline) carries a path instead of the token. The dir is 0700 and the file 0600; `remove` deletes both.
 */
export function writeRedirectPage(url: string): {
  path: string;
  remove(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "catherd-panel-"));
  const path = join(dir, "sign-in.html");
  writeFileSync(
    path,
    `<!doctype html><meta charset="utf-8"><title>catherd panel</title><script>location.replace(${JSON.stringify(url)})</script>\n`,
    { mode: 0o600 },
  );
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The command that opens `url` in the user's browser on `platform`. */
export function openerFor(platform: NodeJS.Platform, url: string): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

/** Opens `url` in the default browser, detached; a machine with no opener simply opens nothing. */
export function openUrl(url: string): void {
  try {
    Bun.spawn(openerFor(process.platform, url), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    }).unref();
  } catch {
    // no opener on PATH: the printed link still works
  }
}
