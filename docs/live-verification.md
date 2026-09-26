# Live verification

What CI cannot check, because it needs real accounts: the backends' real streams, the Codex sandbox, and
the Jev key prompt on a real terminal (spec D7, §11.7, §11.8). Run it on your own machine before a
release, and again after a backend CLI's minor release. Every step says what to look for; write down
anything that differs and file it with the step's name.

You need: Bun ≥ 1.4, a catherd checkout (`git clone https://github.com/47vigen/catherd && cd catherd &&
bun install`), and the three backends logged in: Codex with your ChatGPT account (`codex login`), Claude
Code with your Claude plan (`claude` once, then `/login`), and opencode v2 (`opencode auth login` for
OpenCode Go; the free Zen model needs no login). Run every command from the checkout. The live tests and
the capture spend a few cents at most: they run Luna at low effort, Haiku, and opencode's free model.

## 1. Readiness

```sh
bun src/cli.ts doctor
```

Look for: `✓ ready` on the `codex`, `claude-code` and `opencode` rows, each with its version and model
count; the `codex` row says `ChatGPT login`. `API key login` there means Codex bills you per token: run
`codex login` and choose ChatGPT, or tell catherd with `catherd profile set billing.codex metered`.

## 2. The live tests

```sh
CATHERD_LIVE=1 bun test test/live/codex.live.test.ts
CATHERD_LIVE=1 bun test test/live/claude-code.live.test.ts
CATHERD_LIVE=1 bun test test/live/opencode.live.test.ts
CATHERD_LIVE=1 TYPESAFE_API_KEY=<your TypeSafe key> bun test test/live/jev.live.test.ts
```

Each file runs in its own temporary `CATHERD_HOME` and a scratch git repository; your config is not
touched. Without `CATHERD_LIVE=1` every live test is skipped (the jev file also needs the key).

Look for: every test passing. In particular: Codex answers and resumes the same thread, and its image tool
returns an image; claude-code reports tokens and a cost, resumes its session, and a read-only role does not
create `out.txt`; opencode runs a brief that starts with `---`, refuses a variant the model lacks, keeps
its read-only agent from writing, and cancels a running session; Jev routes the sample lane to Track A and refuses a fake key.

## 3. Fixture capture

```sh
bun src/cli.ts capture-fixtures
```

It records one cheap run per ready backend (and, for claude-code and opencode, a read-only role trying to
write) into `test/fixtures/adapters/<backend>/<cli-version>/`, with secrets, e-mail addresses and home paths
stripped. Every run is isolated (Codex in a catherd-owned `CODEX_HOME`, Claude with `--safe-mode`, opencode
on a standalone server), so no hook, plugin, MCP server or setting of yours appears in the stream.
`--backend codex` (or `claude-code`, `opencode`) records one backend; `--out <dir>` writes elsewhere.

Look for: a `✓` line per case with `(exit 0)`; then check that nothing personal remains:

```sh
git status --short test/fixtures/adapters
grep -rn -e "$HOME" -e "$(whoami)" test/fixtures/adapters/*/*/ || echo clean
```

Look at every line the `grep` prints (a user name that is also a common word may match harmlessly);
`clean` means there is nothing to look at. Each case's `.json` file holds the settled outcome: `status` is
`ok` in both cases, and in `read-only-write` the reply in the stream says why it could not write. Then run the contract suites against the curated fixtures, and
commit the captured folder:

```sh
bun test test/adapters
git add test/fixtures/adapters && git commit -m "test(fixtures): capture <cli versions> streams"
```

If a stream's shape changed (a new event type, a renamed field, a token count in a new place), the
curated fixture beside it (`test/fixtures/adapters/<backend>/*.jsonl`) no longer shows what the CLI does:
file it against that backend's adapter with both files attached.

## 4. The Codex sandbox and the heavy-lock directory

`catherd doctor` checks that a Codex worker in its `workspace-write` sandbox can write catherd's heavy-lock
directory, so `catherd lock` works inside it (spec §10.3). The check has only run against the simulator.
First see that your Codex has the command, then run the two probes doctor runs (use `linux` in place of
`macos` on Linux):

```sh
codex sandbox --help
cd "$(mktemp -d)"
codex sandbox macos --full-auto -- sh -c true; echo "control: $?"
mkdir -p ~/.local/share/catherd/locks
codex sandbox macos --full-auto -- sh -c 'touch "$1" && rm -f "$1"' _ ~/.local/share/catherd/locks/.probe; echo "lock dir: $?"
cd -
bun src/cli.ts doctor
```

(With `XDG_DATA_HOME` set, the lock directory is `$XDG_DATA_HOME/catherd/locks`.)

Look for: `codex sandbox --help` listing `macos` and `linux` (or `seatbelt` and `landlock`: then say so, the
command changed); `control: 0`. Then either `lock dir: 0` and doctor's `sandbox:codex` row `✓ ready`, or
`lock dir: 1` with `Operation not permitted` and doctor's row `! not writable` with a fix naming
`writable_roots` in `~/.codex/config.toml`. Apply that fix, run the probe again, and look for
`lock dir: 0`. Record which of the two you saw: if Codex refuses the lock directory by default, a later
release should add it to `writable_roots` for workspace-write runs itself (plan 5's follow-up).

## 5. The Jev key prompt on a real terminal

In a new terminal window (a real TTY, not an editor's output pane), with a throwaway home so your own
setup is untouched:

```sh
export CATHERD_HOME="$(mktemp -d)" CATHERD_CLAUDE_AGENTS_DIR="$(mktemp -d)"
unset TYPESAFE_API_KEY
bun src/cli.ts init
```

Look for, one at a time:

1. The prompt `TypeSafe API key for Jev (optional; Enter skips): `.
2. Typing shows one `*` per character and never the character itself; Backspace removes one `*`.
3. Pasting the key (from your password manager) shows stars only.
4. Enter prints `✓ Jev: the key answers; saved with mode 600`, then the profile, the model listing, the
   readiness report and the plugin steps; the command exits 0 (`echo $?`).
5. `stat -f %Lp "$CATHERD_HOME/config/credentials.json"` (macOS) or
   `stat -c %a "$CATHERD_HOME/config/credentials.json"` (Linux) prints `600`.
6. `bun src/cli.ts init` again prints `✓ Jev: using the saved key` and asks nothing about the key.
7. `rm "$CATHERD_HOME/config/credentials.json"; bun src/cli.ts init`, then Ctrl-C at the key prompt: the
   command exits 130 (`echo $?`), and what you type next echoes normally (the terminal is not left in raw
   mode).
8. `printf '\n' | bun src/cli.ts init` skips the key (`- Jev: no key; …`) and finishes without waiting.

Clean up with `rm -rf "$CATHERD_HOME" "$CATHERD_CLAUDE_AGENTS_DIR"; unset CATHERD_HOME CATHERD_CLAUDE_AGENTS_DIR`.

## 6. One orchestrated run

The last check drives the plugin in Claude Code on a sample repository: "the plugin in a fresh Claude
Code session" in [`docs/manual-tests.md`](manual-tests.md).
