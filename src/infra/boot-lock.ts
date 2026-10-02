import { join } from "node:path";
import { tryLock } from "./filelock.ts";
import { log } from "./log.ts";
import { locksDir } from "./paths.ts";
import { ensurePrivateDir } from "./store.ts";

/** The machine-wide lock the MCP server that runs the boot sync and reconcile holds for its life. */
export const bootLockTarget = (): string => join(locksDir(), "mcp-boot");

/**
 * Plan 22 (the three MCP servers of one Codex session): boot sync and reconcile are single-flight across
 * processes. The first server takes this lock (its pid and start time in it; a dead holder's is reclaimed) and
 * keeps it until it closes; a second server finds it held and skips both. Returns the release, or null while
 * another live server holds it. A lock that cannot be taken for another reason never costs a reconcile: the
 * server runs the boot work, with nothing to release.
 */
export function takeBootLock(): (() => void) | null {
  try {
    ensurePrivateDir(locksDir());
    return tryLock(bootLockTarget());
  } catch (e) {
    log("warn", "boot", { lock: bootLockTarget(), error: e instanceof Error ? e.message : String(e) });
    return () => {};
  }
}
