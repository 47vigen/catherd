// Run by test/infra/filelock.test.ts.
//   bun lock-worker.ts count <target> <iterations> <startAtMs>
//     waits until startAt so every worker contends at once, then increments the counter file
//     `iterations` times, each read-modify-write inside withFileLock.
//   bun lock-worker.ts crash <target>
//     takes the lock and dies holding it (SIGKILL), leaving a dead holder for the others to reclaim.
import { readFileSync, writeFileSync } from "node:fs";
import { withFileLock } from "../../../src/infra/filelock.ts";

const [mode, target = "", iterations = "0", startAt = "0"] = process.argv.slice(2);
const opts = { timeoutMs: 30_000, pollMs: 1 };
if (mode === "crash") {
  await withFileLock(target, () => process.kill(process.pid, "SIGKILL"), opts);
} else {
  await Bun.sleep(Math.max(0, Number(startAt) - Date.now()));
  for (let i = 0; i < Number(iterations); i++) {
    await withFileLock(
      target,
      async () => {
        const n = Number(readFileSync(target, "utf8"));
        await Bun.sleep(1);
        writeFileSync(target, String(n + 1));
      },
      opts,
    );
  }
}
