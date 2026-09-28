import { errorMessage } from "../domain/errors.ts";
import { scrubSecrets } from "../infra/env.ts";

/** How `init` finds and installs the global `catherd` (injectable: tests never reach the registry). */
export interface GlobalInstallDeps {
  /** what the `catherd` on PATH prints for --version; null when there is none or it does not answer */
  installedVersion(): Promise<string | null>;
  /** `bun add -g catherd-cli@<version>`, with its output */
  install(version: string): Promise<{ ok: boolean; output: string }>;
}

export type GlobalInstall =
  | { state: "current" }
  | { state: "installed" }
  /** installed, but the `catherd` first on PATH is another version (or none), so the launcher still runs bunx */
  | { state: "shadowed"; onPath: string | null }
  | { state: "failed"; reason: string };

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; output: string }> {
  const p = Bun.spawn(cmd, {
    env: scrubSecrets(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { ok: code === 0, stdout: out, output: `${err}${out}` };
}

export const realGlobalInstall: GlobalInstallDeps = {
  async installedVersion() {
    const bin = Bun.which("catherd", { PATH: process.env.PATH ?? "" });
    if (!bin) return null;
    const r = await run([bin, "--version"]).catch(() => null);
    // stdout only: a warning on stderr must not make this version look like another one
    return r?.ok ? r.stdout.trim() : null;
  },
  install: (version) =>
    run([process.execPath, "add", "-g", `catherd-cli@${version}`]).catch((e: unknown) => ({
      ok: false,
      output: errorMessage(e),
    })),
};

/**
 * Spec 1.1 §12: the global CLI at `version`, so the plugin's launcher starts it without a bunx resolve.
 * `installing` runs before anything is resolved, so the user sees why the next seconds pass.
 */
export async function ensureGlobal(
  version: string,
  deps: GlobalInstallDeps,
  installing: () => void,
): Promise<GlobalInstall> {
  if ((await deps.installedVersion()) === version) return { state: "current" };
  installing();
  // never rejects: a failed install is reported, and init goes on
  const r = await deps.install(version).catch((e: unknown) => ({ ok: false, output: errorMessage(e) }));
  if (r.ok) {
    const onPath = await deps.installedVersion().catch(() => null);
    return onPath === version ? { state: "installed" } : { state: "shadowed", onPath };
  }
  const reason = r.output.split("\n").find((l) => l.trim()) ?? "bun add -g failed";
  return { state: "failed", reason: reason.trim() };
}
