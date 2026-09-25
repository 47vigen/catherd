export interface BackendStatus {
  backend: "codex" | "opencode";
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  fix: string | null;
}

interface Result {
  exitCode: number;
  stdout: string;
}

const PROBES = {
  codex: {
    install: "npm i -g @openai/codex",
    login: "codex login",
    status: ["login", "status"],
    // `codex login status` prints to stderr; its exit code is the answer.
    loggedIn: (r: Result) => r.exitCode === 0,
  },
  opencode: {
    // v2: npm's opencode-ai is v1, which rejects the flags catherd passes
    install: "curl -fsSL https://opencode.ai/v2/install | bash",
    login: "opencode auth login",
    status: ["auth", "list"],
    loggedIn: (r: Result) => r.exitCode === 0 && r.stdout.trim().length > 0,
  },
} as const;

async function run(cmd: string, args: string[]): Promise<Result> {
  // Bun.spawn's own PATH lookup can stay stale across calls when PATH changes mid-process
  // (as tests do), so the binary is resolved by hand against the current PATH each time.
  const bin = Bun.which(cmd, { PATH: process.env.PATH ?? "" });
  if (!bin) return { exitCode: 127, stdout: "" };
  try {
    const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    return { exitCode, stdout };
  } catch {
    return { exitCode: 127, stdout: "" };
  }
}

async function probe(backend: "codex" | "opencode"): Promise<BackendStatus> {
  const p = PROBES[backend];
  const v = await run(backend, ["--version"]);
  if (v.exitCode !== 0) return { backend, installed: false, version: null, loggedIn: false, fix: p.install };
  const version = v.stdout.trim().split(/\s+/).at(-1)?.replace(/^v/, "") ?? null;
  const s = await run(backend, [...p.status]);
  const loggedIn = p.loggedIn(s);
  return { backend, installed: true, version, loggedIn, fix: loggedIn ? null : p.login };
}

export function detectBackends(): Promise<BackendStatus[]> {
  return Promise.all([probe("codex"), probe("opencode")]);
}
