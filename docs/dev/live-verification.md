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

Then check the raw answer doctor reads, since which stream carries it depends on the Codex version:

```sh
codex login status >/tmp/codex-login.out 2>/tmp/codex-login.err; echo "exit: $?"
echo "stdout:"; cat /tmp/codex-login.out; echo "stderr:"; cat /tmp/codex-login.err
```

Look for: `exit: 0` and `Logged in using ChatGPT` on one of the two streams. Write down which one, and
check that no key appears in full. If the wording differs from `using ChatGPT` / `using an API key`, file it
against the codex adapter's probe (doctor would then show no login on the `codex` row).

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

## 4. Worker access: the Codex sandbox and the five probes

A `workspace-write` worker must be able to run its own checks (spec 1.1 §5): write catherd's lock directory and the
temp directory, bind a loopback port, reach the network over HTTPS, and talk to Docker. `catherd doctor` runs these
five probes per backend a workspace-write role uses, in that backend's worker shell with the grants a worker gets,
and reports them in the `access:<backend>` rows; the `sandbox:codex` row says which `codex sandbox` form ran. The
probes have only run against the simulators. Run by hand what doctor runs for Codex (the lock directory is
`$CATHERD_HOME/data/locks` with `CATHERD_HOME` set, `$XDG_DATA_HOME/catherd/locks` with `XDG_DATA_HOME` set):

```bash
codex sandbox --help
L=~/.local/share/catherd/locks; T=$(cd "${TMPDIR:-/tmp}" && pwd -P); mkdir -p "$L"
G=(-c sandbox_mode=workspace-write -c sandbox_workspace_write.network_access=true -c "sandbox_workspace_write.writable_roots=[\"$L\",\"$T\"]")
cd "$(mktemp -d)"
codex sandbox "${G[@]}" -- sh -c true; echo "control: $?"
codex sandbox "${G[@]}" -- sh -c 'touch "$1/.p" && rm -f "$1/.p"' _ "$L"; echo "lock dir: $?"
codex sandbox "${G[@]}" -- sh -c 'touch "$1/.p" && rm -f "$1/.p"' _ "$T"; echo "temp: $?"
codex sandbox "${G[@]}" -- bun -e 'Bun.listen({hostname:"127.0.0.1",port:0,socket:{data(){}}}).stop(true)'; echo "loopback: $?"
codex sandbox "${G[@]}" -- curl -sI https://registry.npmjs.org/-/ping >/dev/null; echo "https: $?"
codex sandbox "${G[@]}" -- docker version >/dev/null; echo "docker: $?"
cd -
bun src/cli.ts doctor
```

Look for: `control: 0` (if not, try the old form, `codex sandbox macos --full-auto "${G[@]:2}" -- …`, and say
which one runs), then `0` on every probe, and doctor's `sandbox:codex` and `access:codex` rows `✓ ready`. Record
each probe that is not `0` with its error line and doctor's row, `! blocked` with a fix per probe.

**Your own Codex `writable_roots` survive.** A `-c …writable_roots=` override replaces the array, so catherd passes
the union of yours (the top-level `[sandbox_workspace_write]` in `~/.codex/config.toml`) and its two. Check both
halves. Make a dir (`R=$(mktemp -d); echo "$R"`) and add it to `writable_roots` under `[sandbox_workspace_write]` in
`~/.codex/config.toml` (create the table if it is missing), then, in the same shell as `G` above:

```bash
cd "$(mktemp -d)"
codex sandbox -c sandbox_mode=workspace-write -- sh -c 'touch "$1/.p"' _ "$R"; echo "config only: $?"
codex sandbox "${G[@]}" -- sh -c 'touch "$1/.p"' _ "$R"; echo "catherd's roots only: $?"
codex sandbox "${G[@]:0:4}" -c "sandbox_workspace_write.writable_roots=[\"$R\",\"$L\",\"$T\"]" -- sh -c 'touch "$1/.p"' _ "$R"; echo "union: $?"
cd -
```

Look for: `config only: 0` and `union: 0`. `catherd's roots only` says whether `-c` replaces (non-zero) or merges
(`0`) the array; record which. Then take `$R` out of `~/.codex/config.toml` again.

**Headless Claude Code with your sandbox on stays sandboxed.** catherd passes `--settings` with a `sandbox` object
(the grants) and, when your sandbox is on, `enabled: true`. Check that your own keys survive the merge. In
`~/.claude/settings.json`, set `"sandbox": {"enabled": true, "filesystem": {"allowWrite": ["<a dir of yours>"]},
"network": {"allowedDomains": ["example.com"]}}`, then:

```bash
S=$(bun -e 'const { claudeAccessArgs } = await import("./src/adapters/claude-code/index.ts"); const a = claudeAccessArgs("workspace-write"); console.log(a[a.indexOf("--settings") + 1])')
echo "$S"
claude -p --permission-prompts none --settings "$S" --allowedTools Bash "Run: touch /etc/catherd-probe; touch <a dir of yours>/.p; curl -sI https://example.com; curl -sI https://registry.npmjs.org/-/ping. Report each command's exit code."
```

Look for: `$S` holds `"enabled":true`; `/etc/catherd-probe` is refused (the sandbox is on); your `allowWrite` dir
is writable and `example.com` answers (your keys were merged, not replaced); the registry is refused unless it is in
your `allowedDomains`. Record the four exit codes. If your `allowWrite` dir or `example.com` fails, `--settings`
replaces those keys: note it for the research note (`docs/research/2026-09-28-worker-access.md` §4).

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
Code session" in [`docs/dev/manual-tests.md`](manual-tests.md). Its first run has one lane; then run the
five checks below, which only a real orchestrated run can show (the real runs so far covered none of them).
Use a throwaway profile, so your own is untouched, and bind it to the sample repository:

```sh
cd <the sample repository>
bun <catherd checkout>/src/cli.ts profile new live-kit
bun <catherd checkout>/src/cli.ts profile use live-kit --repo
```

Every `profile set` below takes `--profile live-kit`. After each check, `bun <catherd checkout>/src/cli.ts
runs show <run id> --json` holds the records; write down what you saw.

1. **Two lanes at once.** Ask `/catherd` for two changes to files that share nothing (for example a
   `--shout` flag in `hello.ts` and a `--count` flag in a separate `count.ts`), in one milestone. Look for:
   two `dispatch` calls whose `admittedAt` values are seconds apart, not a whole lane apart, and in the
   records the second worker's `startedAt` earlier than the first worker's `endedAt`:

   ```sh
   bun <catherd checkout>/src/cli.ts runs show <run id> --json |
     jq -r '.records[] | select(.role == "worker") | "\(.startedAt) \(.endedAt) \(.name)"'
   ```

   Serial intervals (each start after the previous end) are the 0.x defect coming back: record it.
2. **An opencode worker.** `profile set roles.worker.rungs '["opencode:opencode-go/gpt-6-luna#high"]'` (with
   Zen credit instead of OpenCode Go, `opencode:opencode/gpt-6-luna#high`), then a one-lane run. Look for:
   `route` returning that rung with `backend: "opencode"`, a record with `backend` `opencode`, the lane's
   owned file changed, and a `STATUS:` line in the reply. Put the worker rungs back with
   `profile set roles.worker.rungs null`.
3. **A forced climb.** In a one-lane run, once the worker returns, tell the orchestrator: "climb that lane
   with reason `unchanged` and dispatch it again." Look for: `climb` returning the next rung of the lane's
   ladder, a second record for the lane on that rung, dispatched on a fresh thread (no `thread` passed), and the climb
   in `runs_summary({ run })` as `climbsFrom: 1` on the first rung.
4. **Quota failover.** Put a fake `codex` first on the PATH that prints a usage limit for `exec` and
   forwards everything else to your real one, and start Claude Code from that shell, so the catherd
   server inherits the PATH:

   ```sh
   mkdir -p /tmp/fake-codex
   cat > /tmp/fake-codex/codex <<EOF
   #!/bin/sh
   if [ "\$1" = exec ]; then
     cat >/dev/null
     echo '{"type":"thread.started","thread_id":"fake-limit"}'
     echo '{"type":"turn.failed","error":{"message":"You have hit your usage limit. Try again later."}}'
     exit 1
   fi
   exec $(command -v codex) "\$@"
   EOF
   chmod +x /tmp/fake-codex/codex
   PATH="/tmp/fake-codex:$PATH" claude
   ```

   Keep the default failover map (Luna high and Sol medium to OpenCode Go; Sol high and xhigh have no default stand-in), or without Go point the Codex rung
   `route` picks for the lane at a stand-in you have, for example: `profile set failover.codex:gpt-6-luna#high claude-code:claude-sonnet-5#high`.
   Run a one-lane task. Look for: a record with status `limit` on the Codex rung, and a second record on the
   stand-in rung whose `failoverFrom` names the Codex rung; the lane finishes on the stand-in. Afterwards
   `rm -rf /tmp/fake-codex` and start Claude Code again from a normal shell.
5. **A budget stop.** `profile set budget.tokens 1000`, then a run with two milestones. Look for: the first
   dispatch running (the budget is a soft cap), the next `dispatch` refused with `E_RUN_BUDGET` and its
   `fix`, the orchestrator pausing (`set_next` with "paused: …"), and `status(run)` showing the budget
   spent past its cap. Remove it with `profile set budget.tokens null`.

Clean up with `bun <catherd checkout>/src/cli.ts profile use --repo --clear` and
`bun <catherd checkout>/src/cli.ts profile rm live-kit`.
