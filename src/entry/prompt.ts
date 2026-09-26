import { createInterface, type Interface } from "node:readline/promises";
import { EXIT } from "./cli-kit.ts";

/** Plain questions on stdin; `secret` does not echo what is typed. */
export interface Prompter {
  ask(question: string): Promise<string>;
  secret(question: string): Promise<string>;
  close(): void;
}

/** A terminal's hidden input, one character at a time; Ctrl-C exits 130 (spec §8). */
function readSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  return new Promise((resolve) => {
    let value = "";
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.exit(EXIT.interrupted);
        }
        if (ch === "\u007f") {
          if (value) process.stdout.write("\b \b");
          value = value.slice(0, -1);
        } else {
          value += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * Questions for `catherd init`. On a terminal they are asked one by one; piped, stdin is read once and each
 * question takes the next line (an empty or missing line takes the default), so scripts can answer them.
 */
export async function prompter(): Promise<Prompter> {
  if (!process.stdin.isTTY) {
    const lines = (await Bun.stdin.text()).split("\n");
    const next = async (q: string) => {
      const answer = (lines.shift() ?? "").trim();
      process.stdout.write(`${q}\n`);
      return answer;
    };
    return { ask: next, secret: next, close() {} };
  }
  let rl: Interface | null = null;
  return {
    async ask(q) {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return (await rl.question(q)).trim();
    },
    secret: (q) => readSecret(q),
    close() {
      rl?.close();
    },
  };
}
