import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitsCollect,
  collectSeams,
  dispatchPaths,
  endCollect,
  leaseFs,
  markForCollect,
  putBackCollect,
  tryCollect,
} from "../../src/infra/dispatch-dir.ts";
import { processStartTime } from "../../src/infra/proc.ts";

const realLink = leaseFs.link;
afterEach(() => {
  collectSeams.beforeTakeover = async () => {};
  leaseFs.link = realLink;
});

let dead = 0;
async function deadPid(): Promise<number> {
  if (!dead) {
    const p = Bun.spawn(["true"]);
    await p.exited;
    dead = p.pid;
  }
  return dead;
}

const dispatchDir = () => mkdtempSync(join(tmpdir(), "catherd-lease-"));
const me = () => ({ pid: process.pid, startTime: processStartTime(process.pid) });
const lease = (dir: string, owner: unknown) =>
  writeFileSync(dispatchPaths(dir).lease, typeof owner === "string" ? owner : JSON.stringify(owner));
const marked = (dir: string) => existsSync(dispatchPaths(dir).collect);
const leased = (dir: string) => existsSync(dispatchPaths(dir).lease);
const owner = (dir: string) => JSON.parse(readFileSync(dispatchPaths(dir).lease, "utf8")) as { pid: number };
/** The invariant: an undelivered record always has a mark or a lease. */
const held = (dir: string) => marked(dir) || leased(dir);

describe("dead-lease takeover is serialized, and never relinks a moved lease (codex P2, M-1, M-2)", () => {
  it("two collectors reclaiming one dead lease: exactly one gets it, and the record is never left bare", async () => {
    const dir = dispatchDir();
    lease(dir, { pid: await deadPid(), startTime: "gone" });
    const seen: boolean[] = [];
    let inner: boolean | null = null;
    collectSeams.beforeTakeover = async () => {
      collectSeams.beforeTakeover = async () => {};
      seen.push(held(dir));
      inner = await tryCollect(dir);
      seen.push(held(dir));
    };
    const outer = await tryCollect(dir);
    expect([outer, inner].filter(Boolean)).toHaveLength(1);
    expect(seen).toEqual([true, true]);
    expect(leased(dir)).toBe(true);
    expect(owner(dir).pid).toBe(process.pid);
    expect(marked(dir)).toBe(false);
  });

  it("a collector that judged a lease dead does nothing once another collected and delivered it", async () => {
    const dir = dispatchDir();
    lease(dir, { pid: await deadPid(), startTime: "gone" });
    collectSeams.beforeTakeover = async () => {
      collectSeams.beforeTakeover = async () => {};
      expect(await tryCollect(dir)).toBe(true);
      endCollect(dir);
    };
    expect(await tryCollect(dir)).toBe(false);
    // delivered once: no mark, no lease, nothing a later wait could deliver again
    expect(marked(dir)).toBe(false);
    expect(leased(dir)).toBe(false);
  });

  it("turns a dead lease back into the mark under the lock, then collects it the normal way", async () => {
    const dir = dispatchDir();
    lease(dir, { pid: await deadPid(), startTime: "gone" });
    expect(awaitsCollect(dir)).toBe(true);
    expect(await tryCollect(dir)).toBe(true);
    expect(owner(dir).pid).toBe(process.pid);
    putBackCollect(dir);
    expect(marked(dir)).toBe(true);
    expect(leased(dir)).toBe(false);
  });

  it("never takes a live owner's lease, nor a young one that names no owner yet", async () => {
    const dir = dispatchDir();
    lease(dir, me());
    expect(await tryCollect(dir)).toBe(false);
    expect(awaitsCollect(dir)).toBe(false);
    const young = dispatchDir();
    lease(young, "");
    expect(await tryCollect(young)).toBe(false);
    expect(awaitsCollect(young)).toBe(false);
    const old = new Date(Date.now() - 60_000);
    utimesSync(dispatchPaths(young).lease, old, old);
    expect(awaitsCollect(young)).toBe(true);
    expect(await tryCollect(young)).toBe(true);
  });
});

describe("a filesystem without hard links (M-4)", () => {
  it("falls back to an exclusive create for the lease", async () => {
    for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) {
      leaseFs.link = () => {
        throw Object.assign(new Error(code), { code });
      };
      const dir = dispatchDir();
      markForCollect(dir);
      expect(await tryCollect(dir)).toBe(true);
      expect(owner(dir).pid).toBe(process.pid);
      expect(marked(dir)).toBe(false);
      expect(await tryCollect(dir)).toBe(false);
    }
  });
});

describe("leftover lease temp files (M-3)", () => {
  it("are swept when a lease ends: a dead pid's or an old one's, never a live, recent one", async () => {
    const dir = dispatchDir();
    const gone = await deadPid();
    writeFileSync(join(dir, `collect.lease.${gone}.abc`), "{}");
    writeFileSync(join(dir, `collect.lease.dead.${gone}.def`), "{}");
    writeFileSync(join(dir, `collect.lease.${process.pid}.old`), "{}");
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(dir, `collect.lease.${process.pid}.old`), old, old);
    writeFileSync(join(dir, `collect.lease.${process.pid}.fresh`), "{}");
    markForCollect(dir);
    expect(await tryCollect(dir)).toBe(true);
    endCollect(dir);
    expect(readdirSync(dir).sort()).toEqual([`collect.lease.${process.pid}.fresh`]);
  });
});

describe("this process's own identity (macOS: ps can fail for a moment)", () => {
  it("ends its own lease even when the start time it recorded differs from a fresh read", async () => {
    const dir = dispatchDir();
    markForCollect(dir);
    expect(await tryCollect(dir)).toBe(true);
    // as if ps failed while the lease was written, or while it is ended
    lease(dir, { pid: process.pid, startTime: null });
    endCollect(dir);
    expect(leased(dir)).toBe(false);
  });

  it("puts back its own lease as a mark whatever start time it recorded", async () => {
    const dir = dispatchDir();
    markForCollect(dir);
    expect(await tryCollect(dir)).toBe(true);
    lease(dir, { pid: process.pid, startTime: "Mon Jan  1 00:00:00 2001" });
    putBackCollect(dir);
    expect(marked(dir)).toBe(true);
    expect(leased(dir)).toBe(false);
  });

  it("writes every lease with one start time, read once", async () => {
    const a = dispatchDir();
    const b = dispatchDir();
    for (const d of [a, b]) {
      markForCollect(d);
      expect(await tryCollect(d)).toBe(true);
    }
    const read = (d: string) =>
      JSON.parse(readFileSync(dispatchPaths(d).lease, "utf8")) as { startTime: unknown };
    expect(read(a).startTime).toBe(read(b).startTime);
    expect(read(a).startTime).toBe(me().startTime);
  });
});
