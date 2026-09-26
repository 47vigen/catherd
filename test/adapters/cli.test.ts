import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/adapters/cli.ts";
import { exited, snapshotEnv, withHome } from "../helpers.ts";
import { waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());

describe("runCli", () => {
  it("runs in the directory it is given", async () => {
    withHome();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "catherd-cli-")));
    expect(await runCli("pwd", [], { timeoutMs: 10_000, cwd: dir })).toEqual({
      ok: true,
      out: `${dir}\n`,
      err: "",
    });
  });

  it("kills everything the CLI started when it times out, so nothing keeps holding its pipes", async () => {
    withHome();
    const pidFile = join(mkdtempSync(join(tmpdir(), "catherd-cli-")), "pid");
    const t0 = Date.now();
    // the CLI exits at once, but a child it left behind keeps stdout open
    const r = await runCli("sh", ["-c", `sleep 30 & echo $! > ${pidFile}`], { timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, err: expect.stringContaining("timed out after 300 ms") });
    expect(Date.now() - t0).toBeLessThan(5_000);
    const child = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()));
    await waitFor(() => exited(child), 5_000);
  });
});
