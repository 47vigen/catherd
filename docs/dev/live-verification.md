# Live verification

The native Codex candidate is unreleased and held. Its current acceptance is local only: do not request, trigger or re-enable CI, publish, push or change the remote release tag. Sections 1–13 retain historical backend/release procedures; their CI and publication examples are not instructions for this feature. Use [section 14](#14-native-codex-packaging-and-completion-acceptance) for the actual packaged host flow, including the unchanged Claude integration. Record untested cases as unverified, never passed by inference.

What CI cannot check, because it needs real accounts: the backends' real streams, the Codex sandbox, and
the Jev key prompt on a real terminal (spec D7, §11.7, §11.8); since 1.1 also the push notices, the worker
access probes and the release acceptance runs (spec 1.1 §15, sections 7 to 9); since 1.2 its acceptance (spec 1.2
§11, section 10); since 1.3 the Cursor, Grok Build and Antigravity adapters (spec 1.3 §10, sections 11 to 13). Run it on your own machine before a
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

## 10. The 1.2 acceptance (the release PR waits for it)

Spec 1.2 §11. Install the release candidate from `changeset-release/main` and the plugin from the same checkout
exactly as in section 9 (its "The CLI" and "The plugin" blocks), then run these four in order. Keep your real
config: the commands below save and restore what they change.

**1. A fresh `init`, with and without an Artificial Analysis key; `doctor` shows every source fresh.**

```sh
export CATHERD_HOME="$(mktemp -d)" CATHERD_CLAUDE_AGENTS_DIR="$(mktemp -d)"   # apart from your own, agents too
ARTIFICIAL_ANALYSIS_API_KEY= catherd init --no-input --no-global
catherd doctor --json | jq -r '.checks[] | select(.id == "sources") | "\(.state) \(.word): \(.detail)"'
```

Look for `ok fresh:` and every keyless source (`models-dev`, `openrouter-models`, `openrouter-endpoints`,
`litellm`, `arena`, `vectara`, `epoch`) under an hour old, and `no Artificial Analysis key`. Then with your key:

```sh
export CATHERD_HOME="$(mktemp -d)" CATHERD_CLAUDE_AGENTS_DIR="$(mktemp -d)"
ARTIFICIAL_ANALYSIS_API_KEY=<your key> catherd init --no-input --no-global
catherd doctor --json | jq -r '.checks[] | select(.id == "sources") | .detail'
ls -l "$CATHERD_HOME/config/credentials.json"   # -rw------- ; the key was tested before it was saved
unset CATHERD_HOME CATHERD_CLAUDE_AGENTS_DIR
```

Look for `artificial-analysis` among the fresh sources and `Artificial Analysis key set, <n> requests left today`.

**2. Clearing every treat-like of yours leaves the profile valid, with warnings.**

```sh
cp ~/.config/catherd/catalog.override.json /tmp/override.before.json 2>/dev/null
catherd catalog treat-like --reset
catherd profile validate; echo "exit $?"
```

Look for: `--reset` names, before its `removed` line, each profile rung left on an inferred stand-in or unscored (none is
fine when you had no treat-likes); `validate` prints no `✗` line, exits 0, and lists each such rung as `stand-in
to confirm: …`. Put yours back with `cp /tmp/override.before.json ~/.config/catherd/catalog.override.json`.

**3. A `terminal` lane and a `ui` lane pick by the terminal and frontend bars, and say each value's source.**

In a scratch repository, start a run and route two lanes through the MCP tools from a Claude Code session:

```sh
scratch="$(mktemp -d)/bars" && mkdir -p "$scratch" && cd "$scratch" && git init -q && git commit -q --allow-empty -m init
claude -p --output-format json \
  "/catherd:catherd Start a run titled bars. Write lanes/M1.L1.md with 'Kind: terminal' and 'Difficulty: copy', and lanes/M1.L2.md with 'Kind: ui' and 'Difficulty: build' (each: Owns: a.txt, Fast check: true), then call route for each and print both answers' rung and provenance.thresholds as JSON. Do not dispatch." \
  | jq -r .result
```

Look for: the terminal lane's thresholds list only `terminal` (its value's `source` `shipped`, Terminal-Bench
4.0), the ui lane's `repo_code` and `frontend` (`frontend`'s source `arena`), each with `min`, `used.value`,
`used.confidence` and `clears`; and the two lanes on different rungs (on the default profile: Sol medium and Sol
xhigh).

**4. The first weekly refresh PR opens with a readable change list.**

```sh
gh workflow run catalog-refresh.yml --repo 47vigen/catherd
sleep 60; gh run list --workflow catalog-refresh.yml --repo 47vigen/catherd --limit 1
gh pr view catalog-refresh --repo 47vigen/catherd
```

Look for: the run succeeds; when anything changed, one PR titled `chore(catalog): refresh scores` with a patch
changeset, whose body lists the rungs newly scored, the values moved by more than 5 % and every bar that moved
(each as a table), and no Artificial Analysis value; when nothing changed, the run's log ends with `no change`
and no PR opens.

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

## 12. Grok Build (1.3, plan 16)

Spec 1.3 §5 and §10, research 2026-09-29 §8 (Grok). Every behaviour below that needs a model turn was read from
grok 1.0.44's user guide or binary and never seen live: plan 16's rulings name what each step confirms. Write down
every difference, with the step's number; a step that fails its "look for" is a ruling to revisit before the release.

**Setup.** Reinstall grok (the owner's `~/.grok/bin/grok` was a Linux build, research §3.1), then log in. For steps
1, 6 and the isolated live test also create a key at console.x.ai and `export XAI_API_KEY=<key>` in that shell only.

```sh
curl -fsSL https://x.ai/cli/install.sh | bash
grok --version                         # grok 1.0.44 (…) or newer
grok login                             # or: grok login --device-code
catherd doctor --json | jq -r '.checks[] | select(.id | test("grok")) | "\(.id) \(.state) \(.word): \(.detail)"'
```

Look for: `backend:grok ok ready: 1.0.44 · Grok login · <n> models` (or `warn billing` with the fix when a profile
that routes to grok bills it otherwise); `sandbox:grok info`, which on a Mac with Docker Desktop or OrbStack says grok
refuses its read-only profile and catherd runs read-only roles with the read tools only; with a grok role on
workspace-write, `access:grok skip not tested` and `isolation:grok warn weak`.

**1. A headless run with the brief by file, and `end` with and without a key (plan 16 Rulings on the stream).**

```sh
catherd capture-fixtures --backend grok --out /tmp/grok-fixtures
ls /tmp/grok-fixtures/grok/*/
```

Needs `XAI_API_KEY` (capture runs isolated). Look for three cases captured: `ok`, `resume`, `read-only-write`. In
`ok.jsonl`: `text` events and the field that holds their text (catherd reads `data`), `tool_call` and
`tool_call_update` events with `toolCallId`, `toolName`, `kind`, `rawInput` and `status`, one `usage` per model
response, and a last `end` whose `sessionId` is the `-s` id catherd passed and which has `total_cost_usd` (an API
key). In `ok.json`: `outcome.status` `ok`, non-zero tokens, the reply is the text after the last tool call. Copy the
streams over `test/fixtures/adapters/grok/` (keeping the synthetic ones' names) and run
`bun test test/adapters/grok*.test.ts`; a failure there is a parser ruling to revisit. Then, with the key unset and
the Grok login, run step 3's live test and look in its run's `events.jsonl` for an `end` without `total_cost_usd`.

**2. The model listing logged in.**

```sh
grok models
catherd catalog refresh && catherd catalog list --backend grok
```

Look for: the first line `You are logged in with …`; the default model (1.0.44 says `grok-4.6`); whether `grok-4.7`
is listed. Every id that differs from `grok-4.7`, `grok-4.6`, `grok-4.5` fixes `on.grok` in `catalog/models.json`.

**3. catherd-ws, a resume, and the read-only profile.**

```sh
CATHERD_LIVE=1 bun test test/live/grok.live.test.ts
sed -n '/# >>> catherd/,/# <<< catherd/p' ~/.grok/sandbox.toml
grok -p hi --sandbox read-only --output-format streaming-json; echo "exit $?"
```

Look for: all tests pass (the isolated one only with `XAI_API_KEY`); the first resumes the session it started and
the reply names `out.txt`; `~/.grok/sandbox.toml` holds catherd's marked block with `[profiles.catherd-ws]` and
`[profiles.catherd-ws-offline]`, and every table of yours is as it was. The last command refuses with "could not
apply the 'read-only' sandbox profile" on a Mac whose docker socket is a link, as research §3.6 saw; elsewhere it
answers. Then run one worker lane (`/catherd` in a scratch repo) whose brief also runs `catherd lock -- true` and
`go env GOCACHE && go build ./...` (or `bun install` in a Bun repo): the lock and the cache writes pass under
`catherd-ws`.

**4. The read tools only, where read-only refuses.** On a Mac with a linked socket, step 3's read-only test ran
`--sandbox workspace --tools read_file,grep,list_dir,web_search,web_fetch`. Look for: no `out.txt`, and in the run's
`events.jsonl` no `tool_call` other than those five tools (the write had no tool to call).

**5. A different `--sandbox` on resume is refused.** With the session id of step 3's first run (`catherd runs show`):

```sh
echo 'Say hi.' > /tmp/grok-brief.md
grok --prompt-file /tmp/grok-brief.md --output-format streaming-json -r <session> --sandbox off; echo "exit $?"
```

Look for: an `error` (write down its text and exit code). catherd never sends this: admission refuses a resume under
another access first (spec 1.3 §3.2).

**6. An isolated HOME loads none of your Claude or Cursor setup.**

```sh
home="$(mktemp -d)"; HOME="$home" GROK_HOME="$home/.grok" GROK_MEMORY=0 \
  GROK_CLAUDE_AGENTS_ENABLED=0 GROK_CLAUDE_RULES_ENABLED=0 GROK_CLAUDE_SKILLS_ENABLED=0 \
  GROK_CLAUDE_MCPS_ENABLED=0 GROK_CLAUDE_HOOKS_ENABLED=0 GROK_CURSOR_AGENTS_ENABLED=0 \
  GROK_CURSOR_RULES_ENABLED=0 GROK_CURSOR_SKILLS_ENABLED=0 GROK_CURSOR_MCPS_ENABLED=0 \
  GROK_CURSOR_HOOKS_ENABLED=0 grok inspect --json | jq .
```

Look for: no plugin, agent, skill or permission rule from your `~/.claude`, and no `~/.agents/skills`; `grok models`
under the same env says `You are using XAI_API_KEY.`

**7. The time from `end` to exit (the upload drain).** In step 3's run dir, compare the `end` event's arrival with the
record's `endedAt`: catherd kills grok 30 s after `end` (`graceAfterFinalMs`). Note how long grok would have run on:
by hand, `time grok --prompt-file /tmp/grok-brief.md --output-format streaming-json` and the seconds after `end`.

**8. An effort grok does not offer.**

```sh
grok --prompt-file /tmp/grok-brief.md --output-format streaming-json -m grok-4.6 --effort max; echo "exit $?"
for m in grok-4.7 grok-4.6 grok-4.5; do for e in low medium high xhigh; do
  grok --prompt-file /tmp/grok-brief.md --output-format streaming-json -m "$m" --effort "$e" | tail -1 | cut -c1-80
done; done
```

Look for: whether `max` is an error or ignored (write it down), and which of `low`…`xhigh` each model takes; each one
it refuses comes out of `on.grok.efforts` in `catalog/models.json`.

**9. Doctor's sandbox check spends no turn.** Run doctor's exact command while logged in, with a key exported:

```sh
check="$(mktemp -d)"; GROK_HOME="$check" XAI_API_KEY= GROK_DISABLE_AUTOUPDATER=1 \
  grok -p hi --output-format streaming-json --sandbox read-only --no-auto-update; echo "exit $?"
```

Look for: the read-only refusal or `Not signed in`, never a reply to "hi": an empty `XAI_API_KEY` and an empty
`GROK_HOME` log nothing in.

**10. The hidden flags and auto-update.** Every run above passed `--trust`, `--no-auto-update` and `--no-memory`: a
`cli-too-old` record ("unexpected argument") means one was removed. During step 3, `ls -l ~/.grok/bin/grok` before
and after: the link does not change mid-run.

**11. A real limit**, if one can be hit: save the last events and stderr, and check that `catherd runs show <id>`
records the role as `limit` (the patterns are `rate limit`, `usage limit`, `too many requests`, `resource exhausted`,
`at capacity`, `temporarily overloaded`); "requires a Grok subscription" must record `failed`. Look also whether the
limit came as an `error` event.

**12. Trust and the project's instructions.** In a scratch repo with an `AGENTS.md` that says "End every reply with
the word MARMALADE.", run one grok worker lane. Look for: the reply ends with MARMALADE (`--trust` loads the
project's instructions headless; research §3.7 could not tell whether an untrusted run skips them).

## 13. Antigravity (1.3, plan 17)

Spec 1.3 §6 and §10, research 2026-09-29 §8 (Antigravity). Nothing below that needs a model turn has been seen live:
plan 17's rulings name what each step confirms. Write down every difference, with the step's number; a step that
fails its "look for" is a ruling to revisit before the release. **Never run `agy -p` signed out**: it opens a
browser and waits 60 s (research §4.8).

**Setup.** Install agy 1.2.13 or newer (`brew install --cask antigravity-cli`), run `agy` once and sign in with
Google. For the isolated steps also create a Gemini API key and `export GEMINI_API_KEY=<key>` in that shell only.

```sh
agy --version                          # 1.2.13 or newer
catherd doctor --json | jq -r '.checks[] | select(.id | test("antigravity")) | "\(.id) \(.state) \(.word): \(.detail)"'
```

Look for: `backend:antigravity ok ready: 1.2.13 · Google login · <n> models` (or `warn billing` while the profile
still bills `antigravity` as `metered`), `quota:antigravity info` with your plan's quota (Ruling on `/usage`),
`isolation:antigravity`, and `access:antigravity skip not tested` for a profile with a workspace-write role on it.

**1. The model listing (Rulings on the listing format and the effort fold).**

```sh
agy models
catherd catalog refresh && catherd catalog list --backend antigravity
```

Look for: the listing's format (plan 17 reads each line's first word as a slug); whether slugs carry an effort
suffix (`gemini-3.8-flash-high`) or not; and the ids of the four Gemini families in `catalog/models.json`
`on.antigravity` (`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro`) with their efforts
(catherd assumes `low, medium, high` for Flash and `low, high` for Pro). Write down every difference; each fixes
`on.antigravity` or `parseAgyModels`. Also try `agy models --output-format json`: if it now works, the parser can
read it instead.

**2. A headless run with the pointer prompt (Ruling on the prompt route and the stream).**

```sh
catherd capture-fixtures --backend antigravity --out /tmp/agy-fixtures
ls /tmp/agy-fixtures/antigravity/*/
```

Needs `GEMINI_API_KEY` (capture runs isolated). Look for three cases captured: `ok`, `resume`, `read-only-write`.
In `ok.jsonl`: one `init`, `step_update` events (is each payload nested under `step_update`, as the `result` line
is?), `tool` steps with `tool_name` and `tool_info`, and exactly one `result` with `status: "SUCCESS"`, a
`conversation_id`, and `usage`. In `ok.json`: `outcome.status` `ok`, and non-zero tokens. Check that
`result.response` is the final message only, and whether `input_tokens` includes `cache_read_tokens`. Copy the
three streams over `test/fixtures/adapters/antigravity/` (keeping the synthetic ones' names) and run
`bun test test/adapters/antigravity*.test.ts`; a failure there is a parser ruling to revisit.

**3. The stdin route (the prompt route's fallback).** In a scratch repo:

```sh
scratch="$(mktemp -d)" && cd "$scratch" && git init -q && git commit -q --allow-empty -m init
printf '%s\n' '{"event":"user","message":{"content":"Reply with the word hello."}}' > in.jsonl
agy --input-format stream-json --output-format stream-json --model gemini-3.8-flash --disable-slash-commands < in.jsonl | tail -1
```

Look for: a `SUCCESS` result that says hello. Note it either way; catherd uses the pointer prompt of step 2, and
this route replaces it only if step 2 shows agy ignoring the brief file.

**4. `--sandbox --dangerously-skip-permissions` still confines shell (Ruling on workspace-write).**

```sh
agy -p 'Run the shell command: touch /tmp/catherd-agy-outside.txt. Then run: touch inside.txt. Report each result.' \
  --output-format stream-json --model gemini-3.8-flash --disable-slash-commands --sandbox --dangerously-skip-permissions | tail -1
ls /tmp/catherd-agy-outside.txt inside.txt
```

Look for: `inside.txt` exists and `/tmp/catherd-agy-outside.txt` does not (then `rm` it if it does). If the outside
write went through, the ruling fails: isolated `workspace-write` must use `toolPermission: "proceed-in-sandbox"`
in catherd's settings, and native `workspace-write` stays advisory (spec 1.3 §6.3). Then ask for a `write_file`
outside the repo the same way: the file tools are expected **not** to be confined (enforcement `advisory`).

**5. The isolated deny rules hold headless (Ruling on the settings file and read-only).**

```sh
CATHERD_LIVE=1 bun test test/live/antigravity.live.test.ts
cat ~/.local/share/catherd/agy-home/read-only/.gemini/antigravity-cli/settings.json
```

Look for: both tests pass (the isolated one only with `GEMINI_API_KEY`): the read-only role wrote no `out.txt`. The
settings hold `modelProvider: "gemini"` and `permissions.deny: ["write_file(*)", "command(*)"]`; if agy ignores
that shape, find the documented one and correct `agySettings`. Note where `denied_actions` appear in the stream.

**6. Resume keeps the conversation (Ruling on `sameAccessOnly`).** Step 5's first test resumes the conversation it
started and the reply names `out.txt`. By hand, resume one of step 2's conversation ids with a changed `--sandbox`
(add or drop it): if agy takes the new flags, `resume.sameAccessOnly` can become `false`.

**7. The Keychain login under another HOME (Ruling on isolation keys).**

```sh
HOME="$(mktemp -d)" agy models
```

Look for: `Please sign in` (the login does not follow a moved HOME, so isolation needs the key, spec 1.3 §9 Q6).
If it lists models instead, note it: isolation could then run on the Google login.

**8. A quota stop and `/usage` (Rulings on the limit texts and doctor's quota).**

```sh
agy -p "/usage" --output-format json
```

Look for: an answer with no agent turn (no `step_update`; nothing spent in the quota it prints). If a quota stop can
be hit (a small Gemini API spend cap), save its stderr: the `AGY_ERROR:` line's fields, and check that
`catherd runs show <id>` records the role as `limit`.

**9. Plan terms (spec 1.3 §9 Q7).** On a network that reaches antigravity.google, read the Antigravity terms for
whether an orchestrator may drive `agy` on a consumer plan, and record the answer here. Until then the README
points automation at the API-key route.

**10. Auto-update stays off during a run.** During step 5, `agy --version` before and after is the same, with
`AGY_CLI_DISABLE_AUTO_UPDATE=true` in the worker's env (spec 1.3 §3.3).

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

| Case | Required observation |
| --- | --- |
| Codex CLI, idle | Codex-only initialize/setup succeeds with no Claude config/agent writes. Omitted architect/verifier route exactly to `codex:gpt-6.1-sol#high` / `codex:gpt-6.1-sol#low` and execute through `dispatch`/`result`. A real detached role finishes while the original thread is idle; completion input wakes that same thread; `result` reads and collects its actual record. |
| Codex CLI, busy | With a tool barrier proving an active turn, a detached role finishes; receipt proves enqueue only. After releasing the turn, native processing delivers completion as ordered next input to the same thread. No urgent next-tool-round claim. |
| Codex Desktop, idle and busy | Repeat both cases in the original Desktop conversation with the installed plugin/core. Observe actual user-message processing and assistant continuation, not just a receipt, transcript text echo, separate CLI rollout or owner recollection. Record idle and busy evidence separately. |
| Explicit profiles | Existing materialized fields remain unchanged. Preview `profile reset-host-defaults <profile> --host codex --preview --json`, review the diff/effective defaults and save only with `--expect <reviewed file>`; only architect/verifier `rungs` and `defaultRung` disappear. Explicit model/effort, access, enabled state, network, routing, budget, billing, isolation and failover are preserved. |
| Claude choices from Codex | Explicit `claude-code:` uses its exact model/effort through `dispatch` and checks that dependency only when selected/reachable. Explicit native `claude:` clearly rejects without modifying the profile, offering the exact headless equivalent or deliberate host-default reset; never silently converts. |
| Independent landing gate | Route every role; reviewer and verifier remain independent. A process verifier on any backend counts only through its actual record and a reply opening `VERDICT: PASS`. Missing reviewer/verifier cannot land. Native Claude Agent accounting occurs only on a Claude Code host with route backend `claude`. |
| Cross-host continuation | Explicit `peek(run)` adopts the run in the new host/session; origin and journal remain. `status`, debug inspection, `result` and profile reads do not adopt. Old-owner receipts do not suppress new-owner events, including owner change during send. |
| Coalescing and duplicates | Each coalesced event retains its run/dispatch/event identity; stalled and finished kinds are distinct. Concurrent servers serialize attempts. Repeated completion input reads existing records idempotently and never redispatches or lands twice. |
| Startup, restart, unloaded/interrupted | Durable unread results survive. Accepted or ambiguous events are never blindly resent. Queue input can remain without generation; diagnostics distinguish acceptance, observed processing and collection honestly. |
| Unknown/conflicting host | No owner claim, arbitrary vendor choice or send. Diagnostics remain actionable and durable records remain readable without adopting ownership. Explicit terminal host selection supports setup without fabricating a conversation. |
| Unavailable queue or rejected target | Capability/refusal diagnostics remain actionable and `peek`/`result` recovers durable work. Existing-server invocation requires queue remote support; never starts a competing server or model polling fallback. |
| Legacy Claude Code | Existing native defaults, conditional Agent/accounting, peer inbox priorities, live registry after `/clear`, recovery and `result` collection remain intact. Repeat a real milestone with its reviewer/verifier gate. |

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
   mode)" (Claude Code 2.1.287).
4. **A native Claude subagent cannot steer.** On Claude Code, ask a native verifier (`claude:` rung) to call
   `mcp__plugin_catherd_catherd__dispatch`. Look for: Claude Code refuses the tool (its agent file's
   `disallowedTools`), and the run is unchanged.
5. **Roles without the role server use the CLI forms.** Dispatch an opencode worker whose brief asks it to run
   `catherd run-file read <run> lanes/<lane>.md`, then `catherd run-file read <other run> plan.md`. Look for: the
   first prints the lane file; the second fails with `E_ROLE_SCOPE`.
6. **Scratch.** After any dispatch, `ls <run>/scratch/<name>/` holds what the role wrote to `$TMPDIR` and `/tmp`
   holds nothing new from it; `catherd runs clean <run>` removes the scratch once no role is live.
