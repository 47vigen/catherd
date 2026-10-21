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
