import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import "../../src/adapters/all.ts";
import { readTranscript, tailTranscript } from "../../src/services/transcript.ts";
import { snapshotEnv, tempDir, withHome } from "../helpers.ts";

const dirs: string[] = [];
afterEach(snapshotEnv());
const mk = (content: string): string => {
  const d = tempDir("catherd-transcript-");
  dirs.push(d);
  writeFileSync(join(d, "events.jsonl"), content);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const msg = (t: string) =>
  JSON.stringify({ type: "item.completed", item: { id: t, type: "agent_message", text: t } });
const opts = { limit: 10, raw: false, ended: false };

describe("readTranscript", () => {
  it("pages by line and leaves a partial last line", () => {
    const dir = mk(`${msg("a")}\n${msg("b")}\n${msg("c")}\n{"type":"item.comp`);
    const p1 = readTranscript(dir, "codex", { ...opts, from: 0, limit: 2 });
    expect(p1.items.map((i) => i.line)).toEqual([0, 1]);
    expect(p1.next).toBe(2);
    const p2 = readTranscript(dir, "codex", { ...opts, from: 2 });
    expect(p2.items.map((i) => i.line)).toEqual([2]);
    expect(p2.next).toBe(3);
    expect(p2.ended).toBe(false);
  });

  it("raw gives the lines as written", () => {
    const dir = mk(`${msg("a")}\n${msg("b")}\n`);
    const p = readTranscript(dir, "codex", { ...opts, from: 0, raw: true, ended: true });
    expect(p.items).toEqual([]);
    expect(p.raw).toEqual([msg("a"), msg("b")]);
    expect(p.next).toBe(2);
    expect(p.ended).toBe(true);
  });

  it("a backend with no transcript shows each line raw", () => {
    const dir = mk(`{"x":1}\n\n{"y":2}\n`);
    const p = readTranscript(dir, "cursor", { ...opts, from: 0 });
    expect(p.items).toEqual([
      { kind: "raw", line: 0, text: '{"x":1}' },
      { kind: "raw", line: 2, text: '{"y":2}' },
    ]);
    expect(p.raw).toBeNull();
  });

  it("claude reads with claude-code's parser, and a missing file is empty", () => {
    const dir = mk(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })}\n`,
    );
    expect(readTranscript(dir, "claude", { ...opts, from: 0 }).items).toEqual([
      { kind: "text", line: 0, text: "hi" },
    ]);
    const none = readTranscript(join(dir, "nope"), "codex", { ...opts, from: 0 });
    expect(none).toEqual({ items: [], raw: null, next: 0, ended: false });
  });
});

describe("tailTranscript", () => {
  it("retains later batches when parsing a batch throws", () => {
    dirs.push(withHome());
    const broken = JSON.stringify({ type: "assistant", message: { content: [null] } });
    const valid = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "kept" }] },
    });
    const dir = mk([broken, ...Array<string>(499).fill("{}"), valid].join("\n") + "\n");
    const pages: Parameters<Parameters<typeof tailTranscript>[3]>[0][] = [];
    let poll: () => void = () => {
      throw new Error("poll was not scheduled");
    };
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      poll = callback;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    let stop: (() => void) | undefined;
    try {
      stop = tailTranscript(dir, "claude", 0, (p) => pages.push(p));
      expect(pages).toEqual([]);
      poll();
      expect(pages).toEqual([
        {
          items: [{ kind: "text", line: 500, text: "kept" }],
          raw: [valid],
          next: 501,
        },
      ]);
      poll();
      expect(pages).toHaveLength(1);
    } finally {
      stop?.();
      timer.mockRestore();
    }
  });

  it("reads only the bytes after the last full line it sent", async () => {
    const dir = mk("AAAA\n");
    const file = join(dir, "events.jsonl");
    type Page = Parameters<Parameters<typeof tailTranscript>[3]>[0];
    let wake: (p: Page) => void;
    const wait = () =>
      new Promise<Page>((resolve) => {
        wake = resolve;
      });
    const first = wait();
    const stop = tailTranscript(dir, "cursor", 0, (p) => wake(p), { pollMs: 5 });
    try {
      expect((await first).raw).toEqual(["AAAA"]);
      const second = wait();
      writeFileSync(file, "A\nAA\nB\nC");
      expect(await second).toEqual({
        items: [{ kind: "raw", line: 1, text: "B" }],
        raw: ["B"],
        next: 2,
      });
      const third = wait();
      appendFileSync(file, "\n");
      expect(await third).toEqual({
        items: [{ kind: "raw", line: 2, text: "C" }],
        raw: ["C"],
        next: 3,
      });
    } finally {
      stop();
    }
  });

  it("rereads a truncated file while skipping lines already sent", async () => {
    const dir = mk("AAAA\nBBBB\nCCCC\n");
    type Page = Parameters<Parameters<typeof tailTranscript>[3]>[0];
    let wake: (p: Page) => void;
    const wait = () =>
      new Promise<Page>((resolve) => {
        wake = resolve;
      });
    const first = wait();
    const stop = tailTranscript(dir, "cursor", 0, (p) => wake(p), { pollMs: 5 });
    try {
      expect((await first).next).toBe(3);
      const second = wait();
      writeFileSync(join(dir, "events.jsonl"), "a\nb\nc\nd\n");
      expect(await second).toEqual({
        items: [{ kind: "raw", line: 3, text: "d" }],
        raw: ["d"],
        next: 4,
      });
    } finally {
      stop();
    }
  });

  it("tails lines as they are appended", async () => {
    const dir = mk(`${msg("a")}\n`);
    const got = Promise.withResolvers<{ items: { line: number }[]; raw: string[]; next: number }>();
    const stop = tailTranscript(dir, "codex", 1, (p) => got.resolve(p), { pollMs: 5 });
    appendFileSync(join(dir, "events.jsonl"), `${msg("b")}\n`);
    const p = await got.promise;
    stop();
    expect(p.items.map((i) => i.line)).toEqual([1]);
    expect(p.raw).toEqual([msg("b")]);
    expect(p.next).toBe(2);
  });
});
