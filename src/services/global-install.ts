import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { errorMessage } from "../domain/errors.ts";
import { scrubSecrets } from "../infra/env.ts";

/** How `init` finds and installs the global `catherd` (injectable: tests never reach the registry). */
export interface GlobalInstallDeps {
  /**
   * what the `catherd` in bun's global bin prints for --version; null when there is none or it does not
   * answer. Never PATH: under `bunx catherd-cli init`, PATH first finds bunx's own transient shim.
   */
  globalVersion(): Promise<string | null>;
  /** what the first `catherd` on PATH outside a bunx transient install prints for --version, or null */
  pathVersion(): Promise<string | null>;
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

/** what `bin --version` prints on stdout (a warning on stderr must not make it look like another version) */
async function versionOf(bin: string | null): Promise<string | null> {
  if (!bin) return null;
  const r = await run([bin, "--version"]).catch(() => null);
  return r?.ok ? r.stdout.trim() || null : null;
}

/**
 * bun's global bin folder: `bun pm bin -g`, else where bun puts it by default. `bun pm bin -g` fails
 * (Bun 1.4.2) while the global folder exists without a package.json, which is before the first global install.
 */
async function globalBin(): Promise<string> {
  const r = await run([process.execPath, "pm", "bin", "-g"]).catch(() => null);
  const dir = r?.ok ? r.stdout.trim() : "";
  if (dir) return dir;
  return process.env.BUN_INSTALL_BIN || join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "bin");
}

/** `bunx` runs a package from `<tmp>/bunx-<uid>-<package>@<tag>/node_modules/.bin`, prepended to PATH */
const isBunxBin = (dir: string) => dir.split(/[\\/]/).some((part) => part.startsWith("bunx-"));

export const realGlobalInstall: GlobalInstallDeps = {
  async globalVersion() {
    return versionOf(Bun.which("catherd", { PATH: await globalBin() }));
  },
  async pathVersion() {
    const PATH = (process.env.PATH ?? "")
      .split(delimiter)
      .filter((dir) => dir && !isBunxBin(dir))
      .join(delimiter);
    return versionOf(Bun.which("catherd", { PATH }));
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
  if ((await deps.globalVersion()) === version) return { state: "current" };
  installing();
  // never rejects: a failed install is reported, and init goes on
  const r = await deps.install(version).catch((e: unknown) => ({ ok: false, output: errorMessage(e) }));
  if (r.ok) {
    const onPath = await deps.pathVersion().catch(() => null);
    return onPath === version ? { state: "installed" } : { state: "shadowed", onPath };
  }
  const reason = r.output.split("\n").find((l) => l.trim()) ?? "bun add -g failed";
  return { state: "failed", reason: reason.trim() };
}
