import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostProbe } from "../../src/infra/host-probe.ts";
import { cachesCheck, dockerChecks, dockerDisk, proxiesCheck } from "../../src/services/doctor-docker.ts";
import { snapshotEnv, tempDir } from "../helpers.ts";

afterEach(snapshotEnv());
const saved = { retryMs: hostProbe.retryMs, minFree: dockerDisk.minFreeBytes };
beforeEach(() => {
  hostProbe.retryMs = 0;
});
afterEach(() => {
  hostProbe.retryMs = saved.retryMs;
  dockerDisk.minFreeBytes = saved.minFree;
});

/** A fake docker: `compose … up` fails the first `failures` times; `info` names `root`; every call is logged. */
function fakeDocker(o: { failures: number; root: string }): { log: string } {
  const dir = tempDir("catherd-docker-");
  const log = join(dir, "calls");
  const count = join(dir, "ups");
  writeFileSync(count, "0");
  const bin = join(dir, "docker");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      'case "$*" in',
      `  *" up "*) n=$(cat '${count}'); echo $((n + 1)) > '${count}'; if [ "$n" -lt ${o.failures} ]; then echo 'wget: bad address web:8080' >&2; exit 1; fi ;;`,
      `  info*) echo '${o.root}' ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  process.env.CATHERD_PROBE_DOCKER = bin;
  return { log };
}

describe("doctor's Docker rows (plan 23)", () => {
  it("warns on a Docker client config with a proxies block, and says nothing without one", () => {
    const dir = tempDir("catherd-dockercfg-");
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ proxies: { default: { httpProxy: "http://proxy:3128" } } }));
    expect(proxiesCheck(file)).toMatchObject({
      id: "docker-proxies",
      state: "warn",
      word: "injects proxies",
    });
    writeFileSync(file, JSON.stringify({ auths: {} }));
    expect(proxiesCheck(file)).toBeNull();
    expect(proxiesCheck(join(dir, "missing.json"))).toBeNull();
  });

  it("warns only when the applicable proxies entry sets a proxy value", () => {
    const dir = tempDir("catherd-dockercfg-");
    const file = join(dir, "config.json");
    const proxies = (p: unknown) => writeFileSync(file, JSON.stringify({ proxies: p }));
    // an empty block, or entries with no proxy value, inject nothing
    proxies({});
    expect(proxiesCheck(file, {})).toBeNull();
    proxies({ default: {} });
    expect(proxiesCheck(file, {})).toBeNull();
    proxies({ default: { httpProxy: "", noProxy: "" } });
    expect(proxiesCheck(file, {})).toBeNull();
    // the current docker host's entry wins over default, as the Docker client picks it
    proxies({ "tcp://remote:2376": { httpsProxy: "http://p:3128" } });
    expect(proxiesCheck(file, {})).toBeNull();
    expect(proxiesCheck(file, { DOCKER_HOST: "tcp://remote:2376" })?.id).toBe("docker-proxies");
    proxies({ default: { httpProxy: "http://p:3128" }, "tcp://remote:2376": {} });
    expect(proxiesCheck(file, { DOCKER_HOST: "tcp://remote:2376" })).toBeNull();
    expect(proxiesCheck(file, { DOCKER_HOST: "unix:///other.sock" })?.id).toBe("docker-proxies");
    proxies({ default: { noProxy: "localhost" } });
    expect(proxiesCheck(file, {})?.id).toBe("docker-proxies");
  });

  it("runs no docker without --docker, and reads the proxies block from DOCKER_CONFIG", async () => {
    const { log } = fakeDocker({ failures: 0, root: "/nonexistent" });
    const cfg = tempDir("catherd-dockercfg-");
    writeFileSync(
      join(cfg, "config.json"),
      JSON.stringify({ proxies: { default: { httpProxy: "http://proxy:3128" } } }),
    );
    process.env.DOCKER_CONFIG = cfg;
    const rows = await dockerChecks({ probe: false });
    expect(rows.map((c) => c.id)).toEqual(["docker-proxies"]);
    expect(() => readFileSync(log, "utf8")).toThrow();
  });

  it("probes two compose services by name, retrying once before it calls the network blocked", async () => {
    process.env.DOCKER_CONFIG = tempDir("catherd-dockercfg-");
    const once = fakeDocker({ failures: 1, root: "/nonexistent" });
    const ok = await dockerChecks({ probe: true });
    expect(ok.find((c) => c.id === "docker-network")).toMatchObject({ state: "ok", word: "ready" });
    const calls = readFileSync(once.log, "utf8").split("\n");
    expect(calls.filter((c) => c.includes(" up ")).length).toBe(2);
    // each up is followed by a down that removes the project
    expect(calls.filter((c) => c.includes(" down -v")).length).toBe(2);
    fakeDocker({ failures: 2, root: "/nonexistent" });
    const blocked = (await dockerChecks({ probe: true })).find((c) => c.id === "docker-network");
    expect(blocked).toMatchObject({ state: "warn", word: "blocked" });
    expect(blocked?.detail).toContain("(2 tries, 5 s apart): wget: bad address web:8080");
  });

  it("warns when Docker's data root has little free space", async () => {
    process.env.DOCKER_CONFIG = tempDir("catherd-dockercfg-");
    const root = tempDir("catherd-dockerroot-");
    fakeDocker({ failures: 0, root });
    expect((await dockerChecks({ probe: true })).find((c) => c.id === "docker-disk")).toBeUndefined();
    dockerDisk.minFreeBytes = Number.MAX_SAFE_INTEGER;
    expect((await dockerChecks({ probe: true })).find((c) => c.id === "docker-disk")).toMatchObject({
      state: "warn",
      word: "low",
      fix: "docker image prune -f, then docker builder prune -f",
    });
  });
});

describe("doctor's toolchain caches row (plan 23)", () => {
  it("lists the caches workers may write, and skips when there are none", () => {
    const a = tempDir("catherd-cache-");
    const b = join(a, "go-build");
    mkdirSync(b);
    expect(cachesCheck([a, b])).toMatchObject({ state: "ok", detail: expect.stringContaining(b) });
    expect(cachesCheck([])).toMatchObject({ state: "skip", word: "none" });
    if (process.getuid?.() !== 0) {
      chmodSync(b, 0o500);
      expect(cachesCheck([a, b])).toMatchObject({ state: "warn", word: "not writable" });
      chmodSync(b, 0o700);
    }
  });
});
