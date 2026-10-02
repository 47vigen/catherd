import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realTmpdir, toolchainCaches } from "../adapters/access.ts";
import { runCli } from "../adapters/cli.ts";
import { probeTwice } from "../infra/host-probe.ts";
import { probeTargets } from "./doctor-access.ts";
import type { Check } from "./doctor-checks.ts";

// Plan 23: the rows that catch what cost the identity and payment runs their verifier rounds: a Docker client
// that injects proxies into every container, a compose network whose services cannot reach each other by
// name, a Docker disk about to fill, and the toolchain caches a sandboxed worker writes.

/** Under this much free space in Docker's data root, doctor warns: image builds start failing near it (tests raise it). */
export const dockerDisk = { minFreeBytes: 10 * 1024 ** 3 };

/** How long the compose probe may take, an image pull included. */
export const composeProbe = { timeoutMs: 120_000 };

/** The Docker client's config file: $DOCKER_CONFIG/config.json, else ~/.docker/config.json. */
export const dockerConfigFile = (env = process.env): string =>
  join(env.DOCKER_CONFIG || join(env.HOME || homedir(), ".docker"), "config.json");

/** The keys of a proxies entry the Docker client turns into container environment variables. */
const PROXY_KEYS = ["httpProxy", "httpsProxy", "noProxy", "ftpProxy", "allProxy"];

/** The Docker client's default daemon host, which its proxies block may key an entry by. */
const DEFAULT_DOCKER_HOST = "unix:///var/run/docker.sock";

/**
 * A `proxies` block in the Docker client's config that sets a value: every container then gets HTTP_PROXY and its
 * siblings. The Docker client applies the current daemon host's entry, else `default`; an entry with no value
 * (or an empty block) injects nothing.
 */
export function proxiesCheck(
  file = dockerConfigFile(),
  env: Record<string, string | undefined> = process.env,
): Check | null {
  let config: { proxies?: unknown };
  try {
    config = JSON.parse(readFileSync(file, "utf8")) as { proxies?: unknown };
  } catch {
    return null;
  }
  const proxies = config.proxies;
  if (!proxies || typeof proxies !== "object") return null;
  const entries = proxies as Record<string, unknown>;
  const host = env.DOCKER_HOST || DEFAULT_DOCKER_HOST;
  const entry = Object.hasOwn(entries, host) ? entries[host] : entries.default;
  const sets =
    !!entry &&
    typeof entry === "object" &&
    PROXY_KEYS.some((k) => {
      const v = (entry as Record<string, unknown>)[k];
      return typeof v === "string" && v.trim() !== "";
    });
  if (!sets) return null;
  return {
    id: "docker-proxies",
    label: "Docker client proxies",
    state: "warn",
    word: "injects proxies",
    detail: `${file} has a proxies block: every container gets HTTP_PROXY, so compose services cannot reach each other by name and a loopback health check goes to the proxy`,
    fix: `remove the proxies block from ${file}, or add the compose service names and 127.0.0.1 to its noProxy`,
  };
}

/** Two busybox services: `web` serves on 8080 with a loopback health check, `probe` fetches it by name. */
const COMPOSE = `services:
  web:
    image: busybox:1.36
    command: ["httpd", "-f", "-p", "8080", "-h", "/etc"]
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/hostname"]
      interval: 1s
      retries: 30
  probe:
    image: busybox:1.36
    depends_on:
      web:
        condition: service_healthy
    command: ["wget", "-q", "-O", "/dev/null", "http://web:8080/hostname"]
`;

/** `docker compose up` on the two-service file, then `down`; the result of the up. */
async function composeUp(docker: string): Promise<{ ok: boolean; why: string }> {
  const dir = mkdtempSync(join(realTmpdir(), "catherd-compose-"));
  const file = join(dir, "compose.yaml");
  writeFileSync(file, COMPOSE);
  const project = ["compose", "-p", `catherd-doctor-${process.pid}`, "-f", file];
  try {
    const up = await runCli(
      docker,
      [...project, "up", "--abort-on-container-exit", "--exit-code-from", "probe"],
      {
        timeoutMs: composeProbe.timeoutMs,
        cwd: dir,
      },
    );
    const lines = `${up?.err ?? ""}\n${up?.out ?? ""}`
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return { ok: up?.ok === true, why: lines.at(-1) ?? "no output" };
  } finally {
    await runCli(docker, [...project, "down", "-v", "--remove-orphans"], { timeoutMs: 30_000, cwd: dir });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Free bytes in Docker's data root, when it is on this machine's disk; null when Docker runs in a VM. */
async function dockerFree(docker: string): Promise<{ root: string; free: number } | null> {
  const r = await runCli(docker, ["info", "--format", "{{.DockerRootDir}}"], { timeoutMs: 15_000 });
  const root = r?.ok ? r.out.trim() : "";
  if (!root || !existsSync(root)) return null;
  try {
    const s = statfsSync(root);
    return { root, free: Number(s.bavail) * Number(s.bsize) };
  } catch {
    return null;
  }
}

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/**
 * The Docker rows: the client's proxies, read from its config file; with `probe` (`catherd doctor --docker`), when
 * a daemon answers, the compose network probe (retried once after 5 s before it calls the host blocked) and the
 * free space in Docker's data root. The probes pull busybox and start containers, so a plain doctor skips them.
 */
export async function dockerChecks(o: { probe: boolean }): Promise<Check[]> {
  const docker = probeTargets.docker;
  const checks: Check[] = [];
  const proxies = proxiesCheck();
  if (proxies) checks.push(proxies);
  if (!o.probe) return checks;
  const version = await runCli(docker, ["version"], { timeoutMs: 15_000 });
  if (!version?.ok) return checks;
  const compose = await runCli(docker, ["compose", "version"], { timeoutMs: 15_000 });
  if (compose?.ok) {
    const { result, attempts } = await probeTwice(
      () => composeUp(docker),
      (r) => r.ok,
    );
    checks.push(
      result.ok
        ? {
            id: "docker-network",
            label: "compose network",
            state: "ok",
            word: "ready",
            detail: "two services reach each other by name, and a loopback health check passes",
          }
        : {
            id: "docker-network",
            label: "compose network",
            state: "warn",
            word: "blocked",
            detail: `a compose service could not reach another by name, or its loopback health check failed (${attempts} tries, 5 s apart): ${result.why}`,
            fix: proxies
              ? (proxies.fix as string)
              : "check the Docker client's proxies, a VPN or socket filter on the Docker bridge, and that busybox can be pulled",
          },
    );
  }
  const free = await dockerFree(docker);
  if (free && free.free < dockerDisk.minFreeBytes)
    checks.push({
      id: "docker-disk",
      label: "Docker disk",
      state: "warn",
      word: "low",
      detail: `${gb(free.free)} free in Docker's data root ${free.root}; builds fail with no space left on device`,
      fix: "docker image prune -f, then docker builder prune -f",
    });
  return checks;
}

/** Whether this user may write `dir`. */
const writable = (dir: string): boolean => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The toolchain caches present on the machine (Go's build and module caches, the pnpm store, Bun's and npm's
 * caches), which join every workspace-write worker's writable roots; a warning for one this user cannot write.
 */
export function cachesCheck(caches = toolchainCaches()): Check {
  const base = { id: "caches", label: "toolchain caches" };
  if (caches.length === 0)
    return { ...base, state: "skip", word: "none", detail: "no Go, pnpm, Bun or npm cache on this machine" };
  const blocked = caches.filter((c) => !writable(c));
  return blocked.length
    ? {
        ...base,
        state: "warn",
        word: "not writable",
        detail: `${blocked.join(", ")}: a worker's checks cannot write it, even with it in their writable roots`,
        fix: `chown -R "$(id -un)" ${blocked.join(" ")}`,
      }
    : {
        ...base,
        state: "ok",
        word: "ready",
        detail: `in every workspace-write worker's writable roots: ${caches.join(", ")}`,
      };
}
