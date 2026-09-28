# Live verification

What CI cannot check, because it needs real accounts: the backends' real streams, the Codex sandbox, and
the Jev key prompt on a real terminal (spec D7, §11.7, §11.8); since 1.1 also the push notices, the worker
access probes and the release acceptance runs (spec 1.1 §15, sections 7 to 9). Run it on your own machine before a
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

   Keep the default failover map (Luna high and Sol medium to OpenCode Go; Sol high and xhigh have no default
   stand-in), or without Go point the Codex rung `route` picks for the lane at a stand-in you have, for example:
   `profile set failover.codex:gpt-6-luna#high claude-code:claude-sonnet-5#high`.
   Run a one-lane task. Look for: a record with status `limit` on the Codex rung, and a second record on the
   stand-in rung whose `failoverFrom` names the Codex rung; the lane finishes on the stand-in. Afterwards
   `rm -rf /tmp/fake-codex` and start Claude Code again from a normal shell.
5. **A budget stop.** `profile set budget.tokens 1000`, then a run with two milestones. Look for: the first
   dispatch running (the budget is a soft cap), the next `dispatch` refused with `E_RUN_BUDGET` and its
   `fix`, the orchestrator pausing (`set_next` with "paused: …"), and `status(run)` showing the budget
   spent past its cap. Remove it with `profile set budget.tokens null`.

Clean up with `bun <catherd checkout>/src/cli.ts profile use --repo --clear` and
`bun <catherd checkout>/src/cli.ts profile rm live-kit`.

## 7. Push notices (1.1)

Finished roles reach the Claude Code session that drove them as messages on its peer inbox (spec 1.1 §3). The
protocol is Claude Code's own and undocumented, so check it after every Claude Code update.

From a plain terminal first, then from inside a Claude Code session (ask Claude to run it with its Bash tool):

```sh
bun src/cli.ts doctor
```

Look for: from the terminal, the `push` row `- no session` with "run catherd doctor from a Claude Code session
to test push". From the session, `✓ ready` on `push`, and the message `catherd doctor: push test <id>, no action
needed` (`<id>` is 8 characters, new on every run) showing up in the session once its turn ends. `! held` means
a `crossSessionInbound` setting (or, on Linux, a permission-mode mismatch) holds the message: apply the row's fix
and run it again. `! not confirmed` means the message was sent but catherd found no transcript of this session to
confirm it arrived: check by eye that the test message showed up in the session; if it did, push works (catherd
looks for the transcript under `$CLAUDE_CONFIG_DIR/projects/`, by default `~/.claude/projects/`). `✗ failed` means this
Claude Code changed the protocol: record the Claude Code version (`claude --version`); `peek` still works.

Then a run: in the session, ask `/catherd` for two changes to files that share nothing, and once it has
dispatched both, ask it something unrelated ("what is 17 × 23?"). Look for: the answer comes at once, while the
roles run; a `<cross-session-message from-name="catherd">` per role (or one message naming both, when they end
within 3 s), each starting `catherd · <run title> · <name> <role> · <rung> · <status>`; and the orchestrator
calling `result` for each record, never `sleep` or `peek` in a loop. Asking "how is it going?" mid-run gets a
`peek` answer with each live role's last event. Then quit Claude Code while a role still runs, start it again
in the same folder with `claude --continue`, and look for: the finished role reported once (by the restart scan
or by `peek`), never twice.

## 8. Worker access (1.1)

The probes by hand are §4: run it there, not here (one procedure, with the flags a worker gets). What §4 does not
cover:

- **The other backends' rows.** With a `workspace-write` role on opencode or claude-code, `bun src/cli.ts doctor`
  shows an `access:opencode` or `access:claude-code` row. Look for: `✓ ready`, or the probes that failed, each
  with its fix. Docker is probed only when `docker` is installed; with OrbStack or Docker Desktop running it must
  pass.
- **A role kept off the network.** With §6's `live-kit` profile (before its clean-up):
  `bun src/cli.ts profile set roles.worker.network false --profile live-kit`, then a one-lane `/catherd` run whose
  brief asks the worker to `curl -fsSI https://registry.npmjs.org/`. Look for: the worker's reply saying the network
  is closed. `doctor`'s `access:<backend>` row for the worker's backend says `network off by profile` (no loopback
  or HTTPS probe) only once every `workspace-write` role on that backend has `network false` in every linked
  profile, the active one and each bound to a repo (writer and artist too, and `default`'s roles while `default`
  is active or bound); on opencode or claude-code it also says `network: false is not enforced` by that shell. Put it back with
  `bun src/cli.ts profile set roles.worker.network null --profile live-kit` (null removes the field).

## 9. The 1.1 acceptance (the release PR waits for it)

Spec 1.1 §15. Nothing is published while "chore: release catherd" is held: npm gets the version, and GitHub the
`v<version>` tag the plugin marketplace points at, only when that PR merges. So both runs use the release
candidate built from the release PR's branch (`changeset-release/main`, the changesets action's branch for
`main`), with no prerelease published.

The CLI, installed globally from that branch:

```sh
git clone https://github.com/47vigen/catherd.git ~/catherd-rc && cd ~/catherd-rc
git fetch origin changeset-release/main && git checkout --detach FETCH_HEAD
bun install --frozen-lockfile
version="$(jq -r .version package.json)"   # the version the release PR sets
bun pm pack                                  # writes catherd-cli-$version.tgz
bun add -g "./catherd-cli-$version.tgz"
catherd --version                            # prints $version
```

The plugin, from the same checkout through a local marketplace (the published one serves the `v<version>` tag,
which does not exist yet). The release PR has stamped the plugin's MCP launcher with `$version`, and the global
`catherd` above reports it, so the launcher starts that `catherd` and never runs bunx:

```sh
claude plugin uninstall catherd@catherd; claude plugin marketplace remove catherd
bun -e '
const fs = require("fs");
const m = ".claude-plugin/marketplace.json";
const k = JSON.parse(fs.readFileSync(m, "utf8"));
k.plugins[0].source = "./plugin"; // the checkout, not the release tag
fs.writeFileSync(m, JSON.stringify(k, null, 2) + "\n");
'
claude plugin marketplace add "$PWD"
claude plugin install catherd@catherd
```

Once both runs have passed and the release PR has merged, go back to the published package and marketplace:

```sh
cd ~/catherd-rc && git checkout .claude-plugin/marketplace.json
claude plugin uninstall catherd@catherd && claude plugin marketplace remove catherd
bun add -g "catherd-cli@$version"
claude plugin marketplace add 47vigen/catherd && claude plugin install catherd@catherd
```

**1. A headless run on a scratch Bun repository.**

```sh
scratch="$(mktemp -d)/acceptance" && mkdir -p "$scratch" && cd "$scratch"
git init -q && bun init -y >/dev/null && git add -A && git commit -qm init
catherd profile new acceptance && catherd profile use acceptance --repo
claude -p --permission-mode bypassPermissions --output-format stream-json --verbose \
  "/catherd:catherd In one milestone, three lanes that share no file: src/slug.ts (slugify a string), src/clamp.ts (clamp a number to a range) and src/chunk.ts (split an array into chunks), each with its own bun test that the worker runs. In a second milestone, src/index.ts re-exports all three. While the first milestone runs, call peek once and tell me how it stands." \
  > run.jsonl
run="$(ls -dt ~/.local/share/catherd/repos/*/runs/*/ | head -1)"
session="$(jq -r 'select(.type == "system" and .subtype == "init") | .session_id' run.jsonl | head -1)"
```

Look for, one at a time:

1. Notices arrived while the session made other calls:
   `grep -c 'from-name=\\"catherd\\"' ~/.claude/projects/*/"$session".jsonl` prints 3 or more, and in `run.jsonl`
   other tool calls sit between the three `dispatch` calls and the first notice.
2. `peek` answered during the run: `grep -o '"name":"mcp__[a-z_]*catherd__peek"' run.jsonl | head -1` prints a
   line, before the last worker's record.
3. Every lane was routed with valid headers:
   `jq -r 'select(.source == "route") | .lane' "$run/routes.jsonl" | sort -u | wc -l` (the routed lanes; the
   header row and climb rows do not count) is at least 4, and
   `grep -hE '^(Kind|Difficulty):' "$run"/lanes/*.md | sort | uniq -c` shows only the catalog's values.
4. A reviewer and a verifier ran before each `land`:
   `catherd runs show "$(basename "$run")" --json | jq -r '.records[] | "\(.startedAt) \(.name) \(.status)"'`
   lists a `reviewer-M1…` and a `reviewer-M2…` record with status `ok`, and
   `jq -r 'select(.role) | "\(.role) \(.name) \(.status)"' "$run/agents.jsonl"` a verifier row naming each
   milestone.
5. A worker ran `bun install` and its tests itself:
   `grep -l 'bun test' "$run"/roles/*/*/events.jsonl` names three dispatch folders
   (`roles/<name>/<dispatch>/events.jsonl`: the folder above each is a worker's name), and no `bun test` appears
   in the orchestrator's own tool calls in `run.jsonl`.
6. Replies carry STATUS: `catherd runs show "$(basename "$run")" --json | jq -r '.records[].replyStatus'` prints
   no `null`.

Clean up with `catherd profile use --repo --clear && catherd profile rm acceptance`.

**2. The real run.** In the `sanitell/platform` checkout:

```sh
glab mr merge 54 --yes && git checkout main && git pull
```

Then open a fresh Claude Code Desktop session on that checkout and send `/catherd auth plan 5, MR B (kit
clean-up)`. Keep using the session while it runs (ask it questions; answer a parked question when one comes).
Right after it has landed, compare with MR A (100 min in all, the verifier about 85 of them); read the numbers
then, since `totals.wallMinutes` counts from the run's start to the moment you ask:

```sh
run="$(catherd runs list --json | jq -r '.runs[0].id')"
catherd status "$run" --json | jq '.runs[0] | {wallMinutes: .totals.wallMinutes, notOk: .totals.notOk, milestones}'
jq -r 'select(.role == "verifier") | "\(.name) \(.status) \((.secs // 0) / 60 | floor) min"' \
  "$(ls -dt ~/.local/share/catherd/repos/*/runs/"$run"/ | head -1)agents.jsonl"
```

Write down: the total minutes, the verifier's minutes and how many gate items it carried over (`carried over
from <commit>` in its verdict), how many worker replies were `partial` or `blocked`, how many test commands the
main thread ran itself (MR A: 156), and whether any notice was missing or doubled.
