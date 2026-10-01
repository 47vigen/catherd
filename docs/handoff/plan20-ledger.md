# Plan 20 implementation ledger

## Task 1 pre-edit native root evidence — 2026-10-01

Evidence gate passed before repository manifest/config edits. Installed native CLI `codex-cli 0.159.2`; pinned official source `799324821d36a822923cee7814d3b80f7ec3cf99` in `/tmp/catherd-codex-messaging-source`. Graph-first discovery found `core-plugins/src/manifest.rs::resolve_manifest_mcp_servers` (440–466), `codex-mcp/src/plugin_config.rs::normalize_plugin_mcp_server_value` (243–305), and `cli/src/mcp_cmd.rs::run_list` (697–960). Explicit manifest `mcpServers` file path and relative host stdio `cwd` are supported; MCP argument macros are not inferred. [Official packaging docs](https://developers.openai.com/plugins/build/plugins) freshly checked; this task uses the installed compatibility `.codex-plugin/plugin.json` layout.

Selected supported declaration: `skills: "./skills/"`, `mcpServers: "./.mcp-codex.json"`; server `catherd` has `command: "sh"`, `args: ["./bin/catherd-mcp"]`, `cwd: "."`, `env: {"CATHERD_ORCHESTRATION_HOST":"codex"}`. No root token or synthetic session ID. Native CLI resolves cwd against the installed plugin root; the argument stays relative and is passed as an array, without shell interpolation.

Safe isolated commands used Python `subprocess.run` argument arrays and a private temporary HOME/CODEX_HOME (all parent host/session identities removed):

```text
/opt/homebrew/bin/codex plugin marketplace add <temporary local marketplace path containing spaces> --json
/opt/homebrew/bin/codex plugin add catherd-evidence@catherd-evidence-market --json
/opt/homebrew/bin/codex mcp list --json
/opt/homebrew/bin/bun <temporary path containing spaces>/handshake.ts
```

All exited 0. First command registers only a local temporary marketplace; second installs into that temporary native config. Third supplies installed-runtime resolution output; fourth is a generic no-model MCP client launching exactly that resolved config. No queue command, model turn, app-server, real native/Claude config write or package build was used. Parent personally read the resolution and handshake output before authorizing source edits.

Installed plugin root: `/private/var/folders/p6/f8p6x5lj3gj1qgxnmdfxmt2m0000gp/T/catherd native root with spaces jf2fgeoo/native config/plugins/cache/catherd-evidence-market/catherd-evidence/1.3.0`. Resolved launcher: `/private/var/folders/p6/f8p6x5lj3gj1qgxnmdfxmt2m0000gp/T/catherd native root with spaces jf2fgeoo/native config/plugins/cache/catherd-evidence-market/catherd-evidence/1.3.0/bin/catherd-mcp`. SHA-256: `111b4041f35fec83da2c6ad48f93bc859147bf0a924c86215d2c72943741eefd`, identical to the unchanged shared launcher. Initialize/tools-list succeeded, 26 tools including status; effective architect/verifier are exact SOL high/low. No synthetic IDs or isolated Claude writes. Matching-version controlled CLI wrapper explicitly executed checkout `src/cli.ts` using `/opt/homebrew/bin/bun`; source CLI SHA-256 `c3ecc7dd9c550ae55e5220f29e6ee5b191a305e883c39f540456a331d6db4145`. This proves launcher feasibility, not packaged/live processing acceptance.

Evidence: `.superpowers/sdd/2026-10-01-20-codex-packaging-acceptance/native-install-resolution.json`, `native-root-handshake.log`, `native-launch-trace.jsonl`; temporary driver path is recorded in `native-preflight-path.txt`. Task 1 regression test will provide a reproducible opt-in isolated native driver. A skipped runtime case is never root proof.

For actual packaged acceptance, install the feature tarball into a temporary prefix, prove actual core executable/package hash, inspect effective native `catherd` configuration and replace the existing native compatibility entry using `${CLAUDE_PLUGIN_ROOT}` without duplicate precedence. Real daemon PATH may differ from caller PATH; no feasibility result claims that the daemon used the feature package. Parent owns these live acceptance checks. No fallback installation decision is needed: installed CLI proved the supported contract.
