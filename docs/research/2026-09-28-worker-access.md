# Worker access: how each backend can run a worker's own checks

Research date: 2026-09-28, for catherd 1.1 spec §5 and §12 (`docs/specs/2026-09-28-catherd-1.1-design.md`).
Sources: the Codex, Claude Code and opencode documentation named below, `docs/research/2026-09-25-opencode.md`
(opencode v2 at 6585bb7, verified live then), the auth-build report (`docs/dev/reports/2026-09-27-auth-build.md`)
and `docs/dev/ideas.md` (1.0.0 sections). Claude Code 2.1.283 is installed where this was written; Codex and
opencode are not, so their parts rest on the docs, the fixtures under `test/fixtures/adapters/` and the simulators
under `test/sim/`. Everything marked **[unverified]** goes to `docs/dev/live-verification.md` §4.

## 1. The intent

A role with `workspace-write` access (worker, writer and artist by default) must be able to: write the repo; read
the disk; reach the network; bind a loopback port; write catherd's lock dir (`<data>/locks`) and the temp dir; talk
to a local Docker socket. Everything else stays closed. `read-only` and `full` do not change. A profile may take the
network, loopback and Docker away from one role with `roles.<role>.network: false`.

The auth build showed why (60 of 171 replies `partial`/`blocked`): under Codex's `workspace-write` sandbox a worker
could not write the lock dir (`catherd lock` failed), reach the Docker socket (testcontainers), `bind()` a loopback
port (a test server) or fetch a module, so the Opus main thread ran 156 test commands itself.

## 2. Codex

**Mechanism.** Codex's `workspace-write` sandbox (Seatbelt on macOS, Landlock plus seccomp on Linux) is configured
by the `[sandbox_workspace_write]` table: `network_access` (bool, default false) and `writable_roots` (extra
writable directories besides the cwd). Both can be set per call with `-c key=value`, the value parsed as TOML, for
`codex exec` and `codex exec resume` alike, and with `--ignore-user-config` (isolated mode) too, since `-c` layers on
top of whatever config is loaded.

```
-c sandbox_workspace_write.network_access=true
-c sandbox_workspace_write.writable_roots=["<locks dir>","<real TMPDIR>"]
```

A JSON array of strings is valid TOML, so catherd writes the list with `JSON.stringify`. The lock and temp dirs go in
by their real paths (`realpath(tmpdir())`: on macOS `/var/folders/…` is `/private/var/folders/…`, and the sandbox
compares real paths).

**The user's own `writable_roots`.** A `-c` value replaces the key it names; as far as the TOML semantics go, Codex
has no array merge, so `-c sandbox_workspace_write.writable_roots=[…]` would drop the roots the user listed (a pip
cache, `~/.m2`). catherd therefore reads the top-level `[sandbox_workspace_write] writable_roots` from
`$CODEX_HOME/config.toml` (default `~/.codex`) and passes the union, the user's first. Limits, for Codex profiles:
roots set under a Codex `--profile` (`[profiles.<name>.sandbox_workspace_write]`) or in a managed requirements file
are not read, so a worker loses them; an isolated run (`--ignore-user-config`) gets catherd's two only, as it gets
none of the user's config. **[unverified]** the replace semantics themselves: live-verification §4 checks that a
root the user configured stays writable.

**Verified** (spec §5, owner's machine, Codex 0.157, 2026-09-28): with these two overrides a lock-dir write,
`docker ps` over the OrbStack socket, a loopback `bind()`, an HTTPS fetch and a `/tmp` write all pass. With
`network_access` off, the loopback bind and the fetch fail, which is what `network: false` wants.

**Docker.** On macOS the socket is reached as a unix socket; Seatbelt lets it through once `network_access` is on
(owner's check with OrbStack). catherd adds nothing Docker-specific for Codex. **[unverified]** Docker Desktop and
Colima sockets under `~/.docker/run` and `~/.colima` — doctor's `docker version` probe reports it per machine.

**`codex sandbox` (doctor).** `ideas.md` records that Codex 0.157 has no `codex sandbox macos --full-auto` any more:
the command is `codex sandbox [--config …] [--permission-profile …] -- <cmd>` with the platform's sandbox implied
(https://learn.chatgpt.com/docs/developer-commands?surface=cli: `--config, -c` "Configuration overrides applied
before launching the sandbox (repeatable)"; `--permission-profile, -P`; macOS also `--allow-unix-socket` and
`--log-denials`). catherd's probe therefore runs

```
codex sandbox -c sandbox_mode=workspace-write -c sandbox_workspace_write.network_access=true \
  -c 'sandbox_workspace_write.writable_roots=[…]' -- sh -c '<probe>' _ <args>
```

and falls back to the old `codex sandbox <macos|linux> --full-auto <same -c> -- …` when the current form does not run
`true`. **[unverified]** that `-c sandbox_mode=workspace-write` is what selects the workspace-write policy for
`codex sandbox` in the current form (the docs name only `--permission-profile` for an explicit policy); the live
check runs the control and the five probes by hand.

## 3. opencode (v2)

**Mechanism.** opencode has no OS sandbox. Its shell tool runs "with the host user's filesystem, process, and
network authority" (research 2026-09-25 §2.6); access is only the agent's permission rules, which gate tools, not
what a shell command reaches. catherd's `catherd-worker` agent (`src/adapters/opencode/agents.ts`) already allows
everything (`*:* allow`, so `external_directory` is allowed too) except `git commit|push|reset --hard` and
`question`, and runs with `--auto`, so no ask ever aborts a run.

So an opencode worker already has the whole intent: lock dir, temp dir, loopback, network and Docker are exactly
what the user's own shell has. Nothing changes in `plan()`.

**`network: false`.** opencode cannot enforce it: there is no sandbox to take the network from a shell command.
Denying `webfetch`/`websearch` in a separate agent would only hide the web tools while `curl` still works, so catherd
does not pretend; doctor's `access:opencode` row says "network: false is not enforced by opencode's shell".

**Doctor.** The probes run in a plain `sh` (the environment opencode's shell tool runs in), from a scratch dir. A
failure there is the machine's own (Docker not running, a firewall, no route to the registry), and the fix says so.

## 4. Headless Claude Code (`claude-code:` rungs)

**Mechanism.** A headless worker runs `claude -p --permission-mode acceptEdits --allowedTools …,Bash
--disallowedTools Bash(git commit *),…` (`src/adapters/claude-code/index.ts`). Claude Code's Bash is **not
sandboxed by default**: its sandbox is opt-in, `sandbox.enabled` in the user's settings
(https://code.claude.com/docs/en/sandboxing, "Configure the sandboxed Bash tool"). With it off, a headless worker's
Bash has the user's full authority, like opencode's shell.

With the user's sandbox on, the relevant settings are (https://code.claude.com/docs/en/settings-reference,
"Sandbox settings"):

| Key | What it does |
| --- | --- |
| `sandbox.filesystem.allowWrite` | "Add paths sandboxed commands can write to" (the cwd, the per-user temp dir and `--add-dir` dirs are writable already) |
| `sandbox.network.allowLocalBinding` | "Let sandboxed commands bind to localhost ports on macOS" |
| `sandbox.network.allowUnixSockets` | "List Unix socket paths sandboxed commands can use on macOS" |
| `sandbox.network.allowedDomains` | "Pre-allow domains so sandboxed commands don't prompt for them" |
| `sandbox.excludedCommands` | "Name commands Claude Code can run outside the sandbox"; the docs: "`docker` is incompatible with the sandbox. Add `docker *` to `excludedCommands`" |

`--settings <file-or-json>` loads extra settings for one invocation (`claude --help`, 2.1.283), so catherd passes, for
a `workspace-write` role:

```json
{"sandbox":{"filesystem":{"allowWrite":["<locks dir>","<real TMPDIR>"]},
 "network":{"allowLocalBinding":true,"allowUnixSockets":["<docker socket>"]},
 "excludedCommands":["docker *"]}}
```

With the sandbox off these keys change nothing (they only configure a sandbox that is not running), so catherd passes
them always rather than reading the user's settings at dispatch. The network block and `excludedCommands` are left
out for `network: false`, which also adds `WebFetch,WebSearch` to `--disallowedTools` (the only network a headless
role has when the sandbox is off is its shell's, which `network: false` cannot take: advisory, as claude-code's
access already is).

**Outbound domains stay the user's.** A sandboxed Bash reaches only `allowedDomains`, and with `--permission-prompts
none` any other domain is denied, not asked. catherd does not widen the user's domain list (the owner's rule: roles
run in the vendor CLI as the user configured it); doctor says to add `registry.npmjs.org` and the hosts the checks
need.

**[unverified]** how `--settings` merges with the user's settings: the docs do not say. A shallow merge would replace
the whole `sandbox` object, dropping the user's `sandbox.enabled` (an unsandboxed Bash for a user who turned the
sandbox on) and their `allowedDomains`; an array replace would drop their own `allowWrite` entries. Defensively,
catherd puts `enabled: true` in the object whenever the user's sandbox is on (read from `~/.claude/settings.json`
and the project's `.claude/settings*.json`, the most specific file that says winning), so the
sandbox stays on under either merge. The domains and `allowWrite` entries are the live check's to settle
(live-verification §4 compares a worker's view with and without catherd's flags).

**Doctor.** With the user's sandbox off, the probes run in a plain `sh`, as for opencode. With it on, only a model
turn runs inside Claude Code's sandbox, so doctor does not spend one: the `access:claude-code` row is `not tested`
and says what to check (the grants catherd passes, and `allowedDomains`).

## 5. The five probes (doctor, spec §5 and §12)

Each probe is `sh -c '<script>' _ <args>` in the backend's worker shell (Codex: `codex sandbox` with the worker's
`-c` grants; opencode and claude-code with its sandbox off: plain `sh`), from a scratch dir, every path and URL as an
argument, never in the script text:

| Probe | Script | Needs network |
| --- | --- | --- |
| lock-dir write | `f="$1/.catherd-doctor-$$" && touch "$f" && rm -f "$f"` with the locks dir | no |
| temp write | the same with the real temp dir | no |
| loopback bind | `"$1" -e 'Bun.listen({hostname:"127.0.0.1",port:0,…}).stop(true)'` with Bun's own path | yes |
| outbound HTTPS | `"$1" -e 'await fetch(process.argv[1],{method:"HEAD"})…' <url>`: `https://registry.npmjs.org/-/ping`; Bun's `fetch` honours `HTTPS_PROXY` | yes |
| docker version | `"$1" version` with `docker`, only when `docker` is on PATH | no |

Bun is the probe interpreter because catherd requires it (`bun ≥ 1.4`) and it is the one runtime every machine that
runs catherd has; `nc`, `python3` or `curl` are not guaranteed. The network probes are reported `off` (not failed)
when every workspace-write role on that backend has `network: false`. `CATHERD_PROBE_URL` and
`CATHERD_PROBE_DOCKER` replace the URL and the docker binary (tests point them at a local server and at no docker, so
no test leaves the machine).

Rows: `sandbox:codex` (which `codex sandbox` form ran, or `not tested`), and `access:<backend>` per backend that
runs or stands in for an enabled workspace-write role: `ready` with what passed, or `blocked` (a warning) with one
fix line per failed probe.
