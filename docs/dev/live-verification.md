# Live verification

Native Codex shipped in 1.4.0, and CI (`.github/workflows/ci.yml`) runs on every PR. Sections 1–11 and 14 keep the per-backend and release procedures of earlier releases. Use [section 14](#14-native-codex-packaging-and-completion-acceptance) for the actual packaged host flow, including the unchanged Claude integration. Record untested cases as unverified, never passed by inference.

What CI cannot check, because it needs real accounts: the backends' real streams, the Codex sandbox, and
the decision model prompts and probe on a real terminal (spec D7, §11.7, §11.8); since 1.1 also the push notices, the worker
access probes and the release acceptance runs (spec 1.1 §15, sections 7 to 9); since 1.3 the Cursor adapter (spec 1.3 §10, section 11; sections 10, 12 and 13 (the 1.2 bars check, Grok Build and Antigravity) were removed in 2.0). Run it on your own machine before a
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
CATHERD_DECISION_LIVE_URL=https://<your-gateway>/v1 CATHERD_DECISION_LIVE_MODEL=<model> CATHERD_DECISION_KEY=<key> \
  bun test test/live/decision.live.test.ts
```

Each file runs in its own temporary `CATHERD_HOME` and a scratch git repository; your config is not
touched. Without `CATHERD_LIVE=1` every live test is skipped, and the decision file is skipped without its three variables.

Look for: every test passing. In particular: Codex answers and resumes the same thread, and its image tool
returns an image; claude-code reports tokens and a cost, resumes its session, and a read-only role does not
create `out.txt`; opencode runs a brief that starts with `---`, refuses a variant the model lacks, keeps
its read-only agent from writing, and cancels a running session.

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

## 5. The decision model prompts and probe on a real terminal

In a new terminal window (a real TTY, not an editor's output pane), with a throwaway home so your own
setup is untouched:

```sh
export CATHERD_HOME="$(mktemp -d)" CATHERD_CLAUDE_AGENTS_DIR="$(mktemp -d)"
unset CATHERD_DECISION_KEY
bun src/cli.ts init
```

Look for, one at a time:

1. The prompts for the decision model's url (`https://<your-gateway>/v1`), its model and its key.
2. Typing shows one `*` per character and never the character itself; Backspace removes one `*`.
3. Pasting the key (from your password manager) shows stars only.
4. Enter prints that the decision model answers the probe and that the key is saved with mode 600, then the profile, the model listing, the
   readiness report and the plugin steps; the command exits 0 (`echo $?`).
5. `stat -f %Lp "$CATHERD_HOME/config/credentials.json"` (macOS) or
   `stat -c %a "$CATHERD_HOME/config/credentials.json"` (Linux) prints `600`.
6. `bun src/cli.ts init` again says it is using the saved key and asks nothing about the key.
7. `rm "$CATHERD_HOME/config/credentials.json"; bun src/cli.ts init`, then Ctrl-C at the key prompt: the
   command exits 130 (`echo $?`), and what you type next echoes normally (the terminal is not left in raw
   mode).
8. `bun src/cli.ts init --no-input` leaves the decision model unset, says so, and finishes without waiting. `catherd doctor` then fails on it, and `run_start` refuses with `E_DECISION_UNSET`.
9. With a url that does not answer, `catherd doctor` fails and `run_start` refuses with `E_DECISION_PROBE`; once it answers, a run starts and records a decision before every dispatch and judge.
10. Output clamps, in a run's role processes: a `claude-code` role has `BASH_MAX_OUTPUT_LENGTH` in its environment and a `codex` role has `tool_output_token_limit` in its config. An `opencode` role has a scratch `TMPDIR`; `opencode` and `cursor` have no output clamp, so a very large command output reaches those roles whole.

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
3. **A fix round never runs below the failed rung.** In a one-lane run whose first review fails, the fix dispatch's
   decision in `decisions.jsonl` has a floor equal to the failed rung, and the lane dispatches on that rung or above.
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

Look for: the terminal has no owner session; the host reports its resolved capability without sending a marker. Ordinary doctor sends nothing. For the explicit smoke, run `bun src/cli.ts doctor --test-push` from the validated Claude session and record the labeled message actually arriving. Record acceptance and observed processing separately; a command/tool transcript echo is not acknowledgement. A held peer inbox or protocol failure keeps unread role results accessible through `peek`/`result`; record the exact diagnostic and Claude Code version. Keep Claude's existing priorities and live registry lookup, including a changed session after `/clear`.

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
bun add -g "$PWD/catherd-cli-$version.tgz"   # absolute: bun resolves ./ from its global folder
catherd --version                            # prints $version
catherd init --no-input                      # rewrites the Claude agent files with 1.1's prompts
```

Start new Claude Code sessions after `init`: the agent files it rewrote load at session start.

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
version="$(jq -r .version package.json)"   # read again: this may be a new shell
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
   `jq -r 'select(.source == "route" and .lane != null) | .lane' "$run/routes.jsonl" | sort -u | wc -l` (the
   routed lanes; the header row and outcome rows and a role's rows outside a lane do not count) is at
   least 4, and
   `grep -hE '^(Kind|Difficulty):' "$run"/lanes/*.md | sort | uniq -c` shows only the catalog's values.
4. A reviewer and a verifier ran before each `land`:
   `catherd runs show "$(basename "$run")" --json | jq -r '.records[] | "\(.startedAt) \(.name) \(.status)"'`
   lists a `reviewer-M1…` and a `reviewer-M2…` record with status `ok`, and
   `jq -r 'select(.role) | "\(.role) \(.name) \(.status)"' "$run/agents.jsonl"` a verifier row naming each
   milestone.
5. A worker ran `bun install` and its tests itself:
   `grep -l 'bun test' "$run"/roles/*/*/events.jsonl` names at least three dispatch folders, one per worker lane
   (a reviewer or verifier that runs `bun test` adds its own; `roles/<name>/<dispatch>/events.jsonl`: the folder
   above each is the role's name), and no `bun test` appears
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
dir="$(ls -dt ~/.local/share/catherd/repos/*/runs/"$run"/ | head -1)"
# a native verifier (a Claude subagent) is in agents.jsonl, a headless one (claude-code:, codex:) in runs.jsonl
jq -r 'select(.role == "verifier") | "\(.name) \(.status) \((.secs // 0) / 60 | floor) min"' \
  "${dir}agents.jsonl" "${dir}runs.jsonl"
```

Write down: the total minutes, the verifier's minutes and how many gate items it carried over (`carried over
from <commit>` in its verdict), how many worker replies were `partial` or `blocked`, how many test commands the
main thread ran itself (MR A: 156), and whether any notice was missing or doubled.

## 11. Cursor (1.3, plan 15)

Spec 1.3 §4 and §10, research 2026-09-29 §8 (Cursor). Every behaviour below that needs a model turn was read from
the binary or the docs and never seen live: plan 15's rulings name what each step confirms. Write down every
difference, with the step's number; a step that fails its "look for" is a ruling to revisit before the release.

**Setup.** `cursor-agent update` (catherd needs 2026.09.28 or newer), then `cursor-agent login`. For steps 7 and 8
also create an API key in the Cursor dashboard and `export CURSOR_API_KEY=<key>` in that shell only.

```sh
cursor-agent --version                 # 2026.09.28-<hash> or newer
catherd doctor --json | jq -r '.checks[] | select(.id | test("cursor|agent")) | "\(.id) \(.state) \(.word): \(.detail)"'
```

Look for: `backend:cursor ok ready: 2026.09.28 · Cursor login · <n> models`; with `agent` on PATH from another
installer, `name:agent info` (catherd runs `cursor-agent` and never the other `agent`).

**1. A headless run with the brief on stdin (plan 15 Rulings on stdin and `result.usage`).**

```sh
catherd capture-fixtures --backend cursor --out /tmp/cursor-fixtures
ls /tmp/cursor-fixtures/cursor/*/
```

Needs `CURSOR_API_KEY` (capture runs isolated). Look for three cases captured: `ok`, `resume`, `read-only-write`.
In `ok.jsonl`: a `system/init` with a `session_id`, `tool_call` events for the write, the read and the shell call,
and a final `result` with `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`). In
`ok.json`: `outcome.status` `ok`, non-zero tokens, and the reply is the text after the last tool call. Copy the
three streams over `test/fixtures/adapters/cursor/` (keeping the synthetic ones' names) and run
`bun test test/adapters/cursor*.test.ts`; a failure there is a parser ruling to revisit.

**2. Plain edits without `--force` (Ruling C-edit), a sandboxed test run and the registry.**

```sh
scratch="$(mktemp -d)" && cd "$scratch" && git init -q && git commit -q --allow-empty -m init
echo 'Create a.txt containing hi, then run `bun --version`, then run `curl -sI https://registry.npmjs.org | head -1`. Report each result.' \
  | cursor-agent -p --output-format stream-json --trust --workspace "$scratch" --model auto --disable-auto-update --sandbox enabled \
  | tail -3; ls "$scratch"
```

Look for: `a.txt` exists (plain edits apply under `--sandbox enabled` without `--force`), a Bun version, and an
HTTP status line. If `a.txt` is missing, Ruling C-edit fails: `workspace-write` must become `--force --sandbox
enabled` with a `permissions.deny` list, and its enforcement `advisory` (spec 1.3 §4.3).

**3. `full` writes outside the repo.** Repeat step 2's command with `--force --sandbox disabled --approve-mcps` in
place of `--sandbox enabled` and the brief `Create /tmp/catherd-outside.txt containing hi.`. Look for the file;
then `rm /tmp/catherd-outside.txt`. With `--sandbox enabled` instead, the same brief must fail to write it.

**4. `--mode ask` refuses writes and shell calls, and does not stall.**

```sh
echo 'Create b.txt containing hi and run `touch c.txt`. If you cannot, say why.' \
  | timeout 300 cursor-agent -p --output-format stream-json --trust --workspace "$scratch" --model auto --disable-auto-update --mode ask --sandbox enabled \
  | tail -2; ls "$scratch"
```

Look for: the run ends by itself with a `result`, and neither `b.txt` nor `c.txt` exists.

**5. Resume keeps the chat from the same cwd (the per-access isolated homes share one `chats` dir).**

```sh
CATHERD_LIVE=1 bun test test/live/cursor.live.test.ts
```

Look for: all tests pass (the isolated one only with `CURSOR_API_KEY` set). The first test resumes the chat it
started and the reply names `out.txt`. By hand, resume a chat id from another directory: Cursor silently starts an
empty chat (research §2.5); note if it errors instead.

**6. The model listing (plan 15's catalog rulings on Cursor ids, efforts and context).**

```sh
cursor-agent models
catherd catalog refresh && catherd catalog list --backend cursor
```

Look for: the slugs of the shipped families in `catalog/models.json` `on.cursor`: `gpt-6-sol`, `gpt-6-luna`,
`claude-opus-5-5`, `grok-4.7`, `cursor-grok-4.6`, `cursor-grok-4.5`, `composer-2.5`, `gemini-3.8-flash`,
`gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro`. Write down
every slug that differs, every other shipped family Cursor lists (Fable, Sonnet, Astra, GPT-5.6), and whether Grok
and Gemini have effort-suffixed slugs; each fixes `on.cursor` in the catalog. Look up each model's context window in
Cursor's model docs (catherd assumes 200K for all).

**7. An isolated HOME with the API key loads none of your Claude Code hooks.**

```sh
home="$(mktemp -d)"; echo 'List the hooks, skills and MCP servers you have loaded. Reply briefly.' \
  | HOME="$home" cursor-agent -p --output-format stream-json --trust --workspace "$scratch" --model auto --disable-auto-update --sandbox enabled \
  | tail -2
```

Look for: the run works on the key alone and names none of your `~/.claude` hooks or skills.

**8. `sandbox.json` in an isolated home is honoured.** Step 5's isolated test wrote the read-only home. For
workspace-write, `catherd profile set harness.cursor.isolated true` in a scratch profile and run one worker lane
(`/catherd` in a scratch repo) whose brief also runs `catherd lock -- true`, then:

```sh
cat ~/.local/share/catherd/cursor-home/read-only/.cursor/sandbox.json        # type workspace_readonly
cat ~/.local/share/catherd/cursor-home/workspace-write/.cursor/sandbox.json  # workspace_readwrite + catherd's roots
```

Look for: the read-only run wrote nothing; the worker wrote in the repo and took the lock (a path from
`additionalReadwritePaths`). Set `harness.cursor.isolated false` again after.

**9. Doctor's access probes through the hidden `sandbox run`.** It joins its arguments with spaces and runs the
result in a shell, so the command goes in as one quoted string.

```sh
cursor-agent sandbox run -- 'echo ok > "$TMPDIR/catherd-probe" && cat "$TMPDIR/catherd-probe"'
catherd doctor --json | jq -r '.checks[] | select(.id == "access:cursor") | "\(.state) \(.word): \(.detail)"'
```

Look for: `ok`, and the access row naming which of the five probes pass under your `~/.cursor/sandbox.json`. If
`sandbox run` is gone (a string instead of a row), the hidden command was removed: the row then says not tested.

**10. A real usage-limit stderr**, if one can be hit: save the stderr and the last events, and check that
`catherd runs show <id>` records the role as `limit` (the patterns are `usage limit`, `rate limit`,
`ActionRequiredError`, `USAGE_LIMIT`). A team policy ("administrator has disabled") must record `failed`.

**11. Auto-update stays off during a run.** During step 5, `ls -l ~/.local/bin/cursor-agent` before and after:
the link does not change mid-run (`--disable-auto-update` is hidden, spec 1.3 §9 Q8).

## 14. Native Codex packaging and completion acceptance

Binding: [Codex entry design](../specs/2026-10-01-catherd-codex-entry-design.md), plans 18–20 and [Plan 20 ledger](../handoff/plan20-ledger.md). The installed native CLI 0.159.2 has proved local marketplace installation, relative plugin-root cwd (including spaces), initialize/tools-list and exact omitted SOL defaults. Native daemon research proved idle wake and ordered busy input. Neither proves that the installed catherd skills/core complete the conversation flow. Record CLI, Desktop and legacy Claude cases separately, with actual evidence or an unverified reason.

### Local packaged candidate, without publication

The remote marketplace still serves stable `v1.3.0`, and an existing global 1.3.0 command may be that stable core. Never treat equal version strings as a feature fingerprint. Build from the candidate checkout and install into a temporary prefix:

```sh
candidate_repo="$PWD"                     # candidate checkout root
acceptance_root="$(mktemp -d)/catherd acceptance with spaces"
mkdir -p "$acceptance_root/core" "$acceptance_root/marketplace/.claude-plugin" \
  "$acceptance_root/home" "$acceptance_root/native config"
bun pm pack --destination "$acceptance_root"
candidate_version="$(bun -e 'console.log((await Bun.file("package.json").json()).version)')"
candidate_tarball="$acceptance_root/catherd-cli-$candidate_version.tgz"
printf '%s\n' '{"name":"catherd-local-acceptance","private":true}' > "$acceptance_root/core/package.json"
bun add --cwd "$acceptance_root/core" "$candidate_tarball"
feature_core="$acceptance_root/core/node_modules/catherd-cli"
cp -R "$feature_core/plugin" "$acceptance_root/marketplace/plugin"
cp .claude-plugin/marketplace.json "$acceptance_root/marketplace/.claude-plugin/marketplace.json"
bun -e 'const p=process.argv[1]; const m=await Bun.file(p).json(); m.name="catherd-local-acceptance"; m.plugins[0].source="./plugin"; await Bun.write(p,JSON.stringify(m,null,2)+"\n")' \
  "$acceptance_root/marketplace/.claude-plugin/marketplace.json"
bun -e 'import {createHash} from "node:crypto"; for(const p of process.argv.slice(1)) console.log(createHash("sha256").update(await Bun.file(p).arrayBuffer()).digest("hex"),p)' \
  "$candidate_tarball" "$feature_core/src/cli.ts" "$feature_core/plugin/bin/catherd-mcp"
"$acceptance_root/core/node_modules/.bin/catherd" --version
```

Record the full tarball hash, actual installed executable/core path, shared launcher hash and package inventory containing both host manifests/configs and both skills. CLI file hash alone does not fingerprint all core modules. This edits only the disposable marketplace source, never the checkout's release tag or version. The supported published marketplace uses `.claude-plugin/marketplace.json` and git-subdir; native CLI accepts local paths or `owner/repo[@ref]`. Remote install instructions in the README apply only after the feature release.

For isolated native parser/config evidence, preserve the real native CLI path but remove inherited conversation identity. This is a temporary native configuration, not a live queue environment:

```sh
native_cli="$(command -v codex)"
isolated_native() {
  env -u CODEX_THREAD_ID -u CODEX_SESSION_ID -u CATHERD_ORCHESTRATION_HOST \
    -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_HOST_SESSION_ID \
    -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
    HOME="$acceptance_root/home" CODEX_HOME="$acceptance_root/native config" \
    CATHERD_HOME="$acceptance_root/catherd home" CATHERD_NO_SYNC=1 \
    CLAUDE_CONFIG_DIR="$acceptance_root/claude config" \
    CATHERD_CLAUDE_AGENTS_DIR="$acceptance_root/claude agents" \
    PATH="$acceptance_root/core/node_modules/.bin:$PATH" "$native_cli" "$@"
}
isolated_native plugin marketplace add "$acceptance_root/marketplace" --json
isolated_native plugin add catherd@catherd-local-acceptance --json
isolated_native mcp list --json
```

Look for one effective `catherd` server with `command: "sh"`, `args: ["./bin/catherd-mcp"]`, `cwd` equal to its installed plugin root and `env.CATHERD_ORCHESTRATION_HOST: "codex"`. The native manifest declares `skills: "./skills/"` and `mcpServers: "./.mcp-codex.json"`; there is no `${CLAUDE_PLUGIN_ROOT}` or synthetic thread/session ID. Check the resolved launcher's hash against the packaged launcher. A no-model SDK client launching exactly this resolved configuration can prove initialize/tools-list. The existing reproducible feasibility test is:

```sh
CATHERD_TEST_NATIVE_PLUGIN=1 bun test test/entry/plugin-packaging.test.ts
```

It uses a controlled checkout core wrapper, so its result is parser/launcher feasibility, not actual packaged conversation acceptance. A skipped case is no proof. `bun test/pack-smoke.ts` separately installs a real tarball, fingerprints it, inventories both integrations and checks no Claude configuration/agent writes; it starts no model turn and sends no queue input. Ordinary `doctor --host codex` sends nothing and skips unused Claude probing; selected explicit headless Claude/reachable failover still receives its required dependency checks.

### Installed CLI and Desktop flow

For actual conversation acceptance, use the user's existing native configuration, credentials and CODEX_HOME so the queue reaches the same existing server/thread. Install the candidate local marketplace/core under the maintainer's controlled acceptance setup and inspect effective configuration before starting either host. Replace any obsolete compatibility declaration containing a literal Claude root macro and avoid duplicate `catherd` precedence. Restore the previous configuration after acceptance. Do not strip configuration to force messaging, invent a socket, start a second app-server or fall back to direct history/SQLite writes.

The daemon's PATH can differ from the installing shell's PATH. Prove the running MCP process actually executes the installed feature core, retaining the package/hash/path evidence above; a same-version stable global command or a published `bunx` fallback invalidates the candidate proof. The shared launcher selects a matching global command or its exact pinned package, so verify that selection in the actual host. Both manifests, launcher and shared skills must come from the same candidate package/version. Read both installed skills end to end before the flow and record their actual paths/fingerprints. Generic handshake success is insufficient.

Native MCP starts in the plugin root. Every repo-aware profile/setup/catalog call must pass the scratch project's explicit `repo`; `run_start(repo, ...)` already does. Tool names and deferred discovery vary: use exposed host capabilities. Codex must never call invented Claude `ToolSearch`, `PushNotification` or `Agent`. Profile notification moments use whatever host facility exists, without a fabricated scheduled-wake promise.

Verify the exact omitted Codex model ID `gpt-6.1-sol` against native catalog discovery and validation. If spelling differs, record the mismatch and resolve it explicitly with the owner before continuing; never silently normalize or substitute a model. Retain architect high and verifier low effort.

Run the following cases through the installed shared skills in a scratch git repository. Use deterministic tool/lifecycle barriers to establish busy state, not a fixed correctness sleep. Save run/dispatch/event IDs, owner journal, actual stored records, receipt/message IDs and timestamps, observed native user-message processing/assistant continuation, and the separate `result` collection marker. Redact secrets from outward evidence.

| Case                                   | Required observation                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex CLI, idle                        | Codex-only initialize/setup succeeds with no Claude config/agent writes. Omitted architect/verifier route exactly to `codex:gpt-6.1-sol#high` / `codex:gpt-6.1-sol#low` and execute through `dispatch`/`result`. A real detached role finishes while the original thread is idle; completion input wakes that same thread; `result` reads and collects its actual record.                           |
| Codex CLI, busy                        | With a tool barrier proving an active turn, a detached role finishes; receipt proves enqueue only. After releasing the turn, native processing delivers completion as ordered next input to the same thread. No urgent next-tool-round claim.                                                                                                                                                       |
| Codex Desktop, idle and busy           | Repeat both cases in the original Desktop conversation with the installed plugin/core. Observe actual user-message processing and assistant continuation, not just a receipt, transcript text echo, separate CLI rollout or owner recollection. Record idle and busy evidence separately.                                                                                                           |
| Explicit profiles                      | Existing materialized fields remain unchanged. Preview `profile reset-host-defaults <profile> --host codex --preview --json`, review the diff/effective defaults and save only with `--expect <reviewed file>`; only architect/verifier `rungs` and `defaultRung` disappear. Explicit model/effort, access, enabled state, network, routing, budget, billing, isolation and failover are preserved. |
| Claude choices from Codex              | Explicit `claude-code:` uses its exact model/effort through `dispatch` and checks that dependency only when selected/reachable. Explicit native `claude:` clearly rejects without modifying the profile, offering the exact headless equivalent or deliberate host-default reset; never silently converts.                                                                                          |
| Independent landing gate               | Route every role; reviewer and verifier remain independent. A process verifier on any backend counts only through its actual record and a reply opening `VERDICT: PASS`. Missing reviewer/verifier cannot land. Native Claude Agent accounting occurs only on a Claude Code host with route backend `claude`.                                                                                       |
| Cross-host continuation                | Explicit `peek(run)` adopts the run in the new host/session; origin and journal remain. `status`, debug inspection, `result` and profile reads do not adopt. Old-owner receipts do not suppress new-owner events, including owner change during send.                                                                                                                                               |
| Coalescing and duplicates              | Each coalesced event retains its run/dispatch/event identity; stalled and finished kinds are distinct. Concurrent servers serialize attempts. Repeated completion input reads existing records idempotently and never redispatches or lands twice.                                                                                                                                                  |
| Startup, restart, unloaded/interrupted | Durable unread results survive. Accepted or ambiguous events are never blindly resent. Queue input can remain without generation; diagnostics distinguish acceptance, observed processing and collection honestly.                                                                                                                                                                                  |
| Unknown/conflicting host               | No owner claim, arbitrary vendor choice or send. Diagnostics remain actionable and durable records remain readable without adopting ownership. Explicit terminal host selection supports setup without fabricating a conversation.                                                                                                                                                                  |
| Unavailable queue or rejected target   | Capability/refusal diagnostics remain actionable and `peek`/`result` recovers durable work. Existing-server invocation requires queue remote support; never starts a competing server or model polling fallback.                                                                                                                                                                                    |
| Legacy Claude Code                     | Existing native defaults, conditional Agent/accounting, peer inbox priorities, live registry after `/clear`, recovery and `result` collection remain intact. Repeat a real milestone with its reviewer/verifier gate.                                                                                                                                                                               |

Ordinary doctor sends no live marker. Only explicitly run `catherd doctor --test-push` from the validated owner session for a labeled smoke input. A terminal `--host codex` selects setup without creating a thread identity. Record CLI queue support and server capability separately; `server: unverified` is uncertainty, not fabricated failure or success. Codex transport invokes `codex queue --remote unix:// --thread <validated original thread UUID> --message <completion text>` with an argument array and the preserved native configuration.

### Delivery recovery and release decision

A native receipt is acceptance only; it never proves the model consumed input, woke, verified or collected work. Only `result(run, name)` performs collection. Recover actual records with `peek`/`result` instead of `await_results`, loops or model polling. Explicit `peek(run)` is an ownership transition, so use it deliberately; status/result inspection is read-only for ownership.

Persisted accepted attempts suppress another enqueue for the same owner/event, including explicit retry. Ambiguous attempts are retained and never automatically retried. No supported queue/history reconciliation API currently exists; arbitrary matching command, tool or assistant text is not delivery acknowledgement. After validating the current owner and exact event shown by peek/status, an explicit possible-duplicate decision uses the existing command from that owner's host session:

```sh
catherd runs retry-push <run> <name> --event '<exact event ID>' --acknowledge-possible-duplicate
```

Preserve all event IDs through retry/coalescing; duplicate input remains an idempotent record read. The actual catherd record and reviewer/verifier gate, not a forged or echoed envelope, determine what can land. Record accepted, ambiguous, failed and collected states separately, and retain unread work on failures.

The controller records exact commands, hashes, actual host observations, deviations and unverified cases in the acceptance report. Release stays held until the real packaged flow passes in both Codex surfaces and Claude Code, including busy ordering and the unchanged gate. No daemon research, fixture, skipped test, source-only skill read or isolated handshake marks an installed skill flow passed. Keep the existing Changesets/stamp/release tooling; this section authorizes neither CI nor publication.

## 15. Roles and ownership (1.5, plan 21)

What the simulators cannot prove: how each vendor CLI hands a role's env to the MCP servers it starts, and which
flags keep the role server alive in an isolated Claude Code run. Use a scratch repo and a profile whose roles run on
Codex and headless Claude Code (`claude-code:` rungs).

1. **A native Codex role cannot take the run (the payment run's P1).** With `harness.codex.isolated` false and the
   catherd plugin installed in Codex, dispatch a verifier whose brief asks it to call catherd's `peek` with the run
   id. Look for: the verifier's reply quotes `E_ROLE_SCOPE`; `catherd runs show <run>` still names the
   orchestrator's thread as owner; the verifier's notice reaches the orchestrator. If the plugin's server answered
   anything else, Codex no longer passes `TMPDIR` to MCP servers: record the Codex version and the env the server
   saw (`catherd mcp` logs `session` at start).
2. **Isolated Codex keeps the role server.** Set `harness.codex.isolated` true and dispatch a verifier. Look for:
   its reply shows it called `mcp__catherd_role__gate_check`; `codex mcp list` inside catherd's `CODEX_HOME` lists
   nothing of the user's.
3. **Isolated Claude Code keeps the role server and drops the rest.** Set `harness.claude-code.isolated` true and
   dispatch a verifier on a `claude-code:` rung, in a repo whose `CLAUDE.md` says "end every reply with BANANA" and
   whose `.claude/settings.json` has a `SessionStart` hook that writes a file. Look for: the role calls
   `mcp__catherd_role__gate_check`; no reply ends with BANANA; the hook's file is absent; the role's `events.jsonl`
   lists only `catherd_role` among its MCP servers. Then confirm the reason for the change once by hand:
   `claude -p --safe-mode --mcp-config '<the role server json>' --debug` logs "--mcp-config: 1 server ignored (safe
   mode)" (Claude Code 2.1.287). Then the settings-file auth: on a machine that logs in through
   `~/.claude/settings.json` (an `apiKeyHelper`, or `env` with `CLAUDE_CODE_USE_BEDROCK`/`ANTHROPIC_BASE_URL`),
   dispatch the same isolated verifier. Look for: it authenticates and replies (catherd carries `apiKeyHelper`,
   `env`, the aws/gcp auth helpers, `model`, `permissions.deny` and `sandbox.network` into `--settings`), and its
   `--settings` in the dispatch's spawn spec holds those keys but no `hooks` or `enabledPlugins`.
4. **A native Claude subagent cannot steer.** On Claude Code, ask a native verifier (`claude:` rung) to call
   `mcp__plugin_catherd_catherd__dispatch`. Look for: Claude Code refuses the tool (its agent file's
   `disallowedTools`), and the run is unchanged.
5. **Roles without the role server use the CLI forms.** Dispatch an opencode worker whose brief asks it to run
   `catherd run-file read <run> lanes/<lane>.md`, then `catherd run-file read <other run> plan.md`. Look for: the
   first prints the lane file; the second fails with `E_ROLE_SCOPE`. Do it with `harness.opencode.isolated` true
   (a standalone server, the only opencode role catherd can bind by env, plan 21 ruling 22), and add a writer and a
   verifier: the writer runs `catherd run-file write <run> notes.md` (stdin) and a verifier `catherd gate pass
<run> …`. Look for: both succeed on their own run, `echo $TMPDIR` in the role prints `<run>/scratch/<name>`,
   and the same commands from a non-isolated opencode role behave as from your terminal (its brief names no
   `$TMPDIR`).
6. **Scratch.** After any dispatch, `ls <run>/scratch/<name>/` holds what the role wrote to `$TMPDIR` and `/tmp`
   holds nothing new from it; `catherd runs clean <run>` removes the scratch once no role is live.

## 16. Delivery and the loop (1.5, plan 22)

On a Codex host (0.159 or later, the app-server daemon running), with catherd from this branch installed as the
plugin, one scratch repo and a run owned by a Codex TUI thread. Record each result in the acceptance report.

1. **A completion survives a detach.** Start the coordinator outside tmux, dispatch one worker whose fast check
   takes about two minutes, then close the terminal (or drop the SSH session) while it runs. Wait past the worker's
   end plus 20 s (the supervisor's grace). Look for: `notify` with `"from":"supervisor"` and `outcome: accepted` in
   `catherd-<date>.jsonl`, and the dispatch's `delivery.json` holding one accepted attempt for the thread. Reattach
   (`codex resume`): the catherd message arrives as the next input, its first line naming `thread:`. Repeat with the
   terminal left attached: the MCP server's push wins (`notify` without `from`), and the supervisor logs nothing
   (its receipt check found the event accepted). This also pins down the daemon behaviour the identity run left
   open (a thread unloaded once no client is attached, and the grace before it).
2. **tmux, once.** In a shell where `$TMUX` and `$STY` are empty, start a run: the coordinator tells the user once
   to run inside tmux, and not again on later turns.
3. **Goal mode.** Set a thread goal, dispatch two workers, and let the goal continue: each continuation ends with no
   tool call while only the workers run. A `peek(run)` in that stretch answers `actionable: false` with its reason.
4. **One MCP server per session.** Open one Codex TUI and count `catherd mcp` processes and `reconcile` log rows: one
   server leads (`reconcile`), any other logs `boot … skipped`.
5. **The push smoke.** From inside the thread, call `test_push`; from a shell, `catherd doctor --test-push --thread
<uuid>` with the uuid the last catherd message named. Both report `enqueue accepted`, and the labeled smoke
   arrives in that thread.
6. **Resume hygiene (exit 143).** Brief a worker to start `sleep 600 &` and reply; then resume its thread for a fix
   round (`thread: "latest"`). The resumed role ends `ok`, not exit 143, and `dispatch` returns the hint
   `resume: stopped what … left running on thread …`. If a resumed worker still exits 143, record the process tree
   of the old turn (`ps -o pid,pgid,sid,cmd`): a background command outside the worker's process group is the case
   plan 22 does not cover.
7. **Two final replies.** Brief a worker to reply, then emit a second short message after a background command's
   notification; `result` returns the report first, the short one under `later:`, and the report's STATUS.

## 17. Verifier, gate and environment (1.5, plan 23)

What the simulator cannot show. Record each observation, with the versions, in the acceptance report.

| Step                          | Required observation                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Testcontainers per dispatch   | Two lanes of one milestone whose fast checks start testcontainers on one Docker daemon run side by side. Each worker's env has its own `TESTCONTAINERS_SESSION_ID` (its dispatch id), and neither fails with "reaper container name already in use". If the testcontainers library in use ignores that variable, record which one, and which variable it reads instead.                                                                                                          |
| opencode provider outage      | On an opencode rung whose provider answers 503 (or with the network to it blocked), the stream shows `step_start` events with nothing between, or the session message carries `retry.attempt`. Within 3 retries or 3 minutes the attempt ends `provider-unavailable`, its record is a `limit` with `error.code: provider-unavailable`, and failover starts the rung's stand-in on another backend. Record whether opencode emits a `step_start` per retry on the version in use. |
| doctor --docker               | On a machine whose `~/.docker/config.json` has a `proxies` block, plain `catherd doctor` warns `docker-proxies`; `catherd doctor --docker` reports `compose network` blocked after two tries 5 s apart, and ready once the block is removed. With less than 10 GB free in Docker's data root on Linux, `docker-disk` warns; on macOS (Docker in a VM) the row is absent.                                                                                                         |
| Long gate behind catherd lock | A verifier whose root gate runs longer than its `wallMin` behind `catherd lock`, printing as it goes, is not stopped at `wallMin`; with the gate silent for `wallMin`, it is. `roles.verifier.timeouts.wallMin` raises the wall for that role alone.                                                                                                                                                                                                                             |

## 18. Install checks from the minors sweep (1.5, plan 26)

Two behaviours only a real install shows. On a machine with a published catherd:

1. **`bunx` and the global install.** With an older global catherd first on PATH (or none), run
   `bunx catherd-cli@latest init --no-input`. `init` must check the catherd in bun's global bin
   (`bun pm bin -g`), not the one bunx puts first on PATH from its own `node_modules/.bin`: it installs or
   reports the global one as current, and says `installed globally, but the catherd first on PATH is <older>`
   (shadowed) while the older one comes first. Then `which catherd && catherd --version` shows what the plugin's
   launcher will start.
2. **A blackholed registry.** In the release candidate checkout (§9), with `bun remove -g catherd-cli` first:
   `BUN_CONFIG_REGISTRY=http://10.255.255.1 bun src/cli.ts init --no-input`. `init` says `installing catherd…`,
   then within about two minutes `could not install catherd globally: add -g catherd-cli@<version> timed out after
120 s` with the retry command, and goes on. Reinstall the candidate afterwards as §9 does.

## 19. The Slopalytics catalog (2.0, plan 29)

On a machine with the release candidate, with your real config (these only read, and fetch the index):

1. **Fetch the index.** `catherd catalog sync --force` prints `+ catalog: <n> pairs, fetched just now` and exits 0.
   `catherd doctor --json | jq '.checks[] | select(.id == "catalog")'` reads `ok fresh` with `<n> pairs`.
2. **Only indexed pairs are offered.** `catherd catalog list --role worker` lists each model with `#<effort>` lines
   that carry an `intelligence` figure; a model Slopalytics does not list is absent. `catherd profile set
roles.worker.rungs codex:gpt-6-sol#turbo` is refused with `has no Slopalytics intelligence index` and the fix
   `pick an indexed pair: catherd catalog list --role worker`.
3. **A run pins its index.** Start a run in a scratch repository: the run's folder (`catherd runs show <id>` names it)
   holds a `slopalytics.json`, and `catherd catalog sync --force` afterwards leaves that file's `fetchedAt` as it was.

## 20. The panel (2.0, plan 31)

On a machine with the release candidate, in a repository, with your real config:

1. **It opens signed in.** `catherd` and `catherd panel` print `catherd panel: http://127.0.0.1:4317/login#token=…`,
   open the browser on Runs with no password asked, and leave the token out of the address bar. A second terminal's
   `catherd panel` says `port 4317 is in use` and names `--port 0`. `catherd --help` prints the help and starts no
   server.
2. **Every page renders.** Runs lists your runs, and a run opens on its milestones, live roles, questions and
   timeline, with new events arriving without a reload. Questions and Setup render; Setup shows each backend's
   doctor status and each role's rungs.
3. **An answer reruns the unit.** Start a run that parks a question (or use one that did), answer it from Questions:
   the unit runs again and the question leaves the list; the daemon's next events show `question.answered`.
4. **A Setup save shows in the profile.** Pick other rungs for a role and save; `catherd profile show` lists them in
   rising intelligence.
5. **Another host is refused.** `curl -H 'Host: evil.test' http://127.0.0.1:4317/api/runs` is 403, and so is a
   `POST` carrying `-H 'Origin: http://evil.test'`.
6. **Cancel run stops a run.** Cancel a live run from its page: its roles stop and the run ends `cancelled`.

## 21. Routing on one scale (2.0, plan 33)

On a machine with the release candidate, with your real config:

1. **Every failover is a row.** In a run with a forced limit, `jq 'select(.source == "failover")' <run>/routes.jsonl`
   shows one row per failover, with the quotas in `held`; a failover with no stand-in has `"rung": null`.
2. **A cap holds.** `catherd profile validate` on the default profile prints no warning; after `catherd profile set
roles.worker.rungs codex:gpt-6.1-sol#max` it says the rung is above `maxEffort xhigh` and that routing skips it.
