# Manual tests

Three checks that need a human at Claude Desktop, because MCP servers and plugins only
load at session start; no automated test can show that. Run them before the first
publish, and again after any Claude Code release that might change MCP call
backgrounding, subagent loading or plugin discovery (see the design spec's Risks
section).

Do these in order: S1 and S2 gate `dispatch` and the Claude agent files that the plugin
smoke test (Task 13) then exercises end to end.

## S1 — a 40-minute MCP call survives from the main thread

**What this checks:** a long `dispatch` call must background itself after about two
minutes and let the orchestrator keep working, then wake it with the result when the
role finishes — without the stdio connection timing out. If this fails, `dispatch`
needs to return a job id instead of blocking, and the orchestrator polls it through
`catherd wait` (see the plan's Task 14).

1. Create `spikes/s1/server.mjs` in your catherd checkout:

   ```js
   import { appendFileSync } from "node:fs";
   import { tmpdir } from "node:os";
   import { join } from "node:path";
   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
   import { z } from "zod";

   const LOG = process.env.S1_LOG ?? join(tmpdir(), "catherd-s1.log");
   const log = (s) => appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);

   const server = new McpServer({ name: "catherd-s1", version: "0.0.0" });

   server.registerTool(
     "sleep",
     {
       description:
         "Spike S1: sleeps for the given minutes, sending a progress notification every tick_secs, then returns.",
       inputSchema: {
         minutes: z.number().default(40),
         tick_secs: z.number().default(60),
         progress: z.boolean().default(true),
       },
     },
     async ({ minutes, tick_secs, progress }, extra) => {
       const token = extra._meta?.progressToken;
       log(`call start minutes=${minutes} progress=${progress} token=${JSON.stringify(token)}`);
       const end = Date.now() + minutes * 60_000;
       let n = 0;
       while (Date.now() < end) {
         await new Promise((r) => setTimeout(r, Math.min(tick_secs * 1000, end - Date.now())));
         n++;
         const send = progress && token !== undefined;
         if (send) {
           await extra.sendNotification({
             method: "notifications/progress",
             params: { progressToken: token, progress: n, message: `tick ${n}` },
           });
         }
         log(`tick ${n} sent=${send} aborted=${extra.signal.aborted}`);
         if (extra.signal.aborted) {
           log("aborted by the client");
           break;
         }
       }
       log("call end");
       return { content: [{ type: "text", text: `S1 done after ${n} ticks at ${new Date().toISOString()}` }] };
     },
   );

   await server.connect(new StdioServerTransport());
   log("server up");
   ```

2. Register it and check it starts:

   ```bash
   claude mcp add --scope user catherd-s1 -- bun "$PWD/spikes/s1/server.mjs"
   claude mcp list | grep catherd-s1
   ```

   Look for: `catherd-s1` listed as connected. If `claude mcp add`'s flags differ on
   your Claude Code version, run `claude mcp add --help` and register a user-scoped
   stdio server the same way.

3. Quit and reopen Claude Desktop, open the Code tab, and start a **new** session in
   any folder (MCP servers load only at session start). Note the clock time, then send
   exactly:

   > Call the catherd-s1 sleep tool with minutes 40 yourself, from this main thread and
   > not from a subagent. When its result arrives, reply with the exact text it
   > returned and the current time.

4. At about 2 minutes, look for: the tool call shown as backgrounded, and the model
   getting its turn back (it replies or ends its turn while the call keeps running).
   Note the time.

5. Leave the session alone. At 30–35 minutes, in a terminal run
   `tail -3 "$TMPDIR/catherd-s1.log"`. Look for: the ticks still arriving, and no MCP
   error or timeout shown in the session.

6. At about 40 minutes, look for: the result arriving as a notification, and the model
   waking on its own with `S1 done after 40 ticks …`. Note the time.

7. Run `head -2 "$TMPDIR/catherd-s1.log"` and note whether `token=` is a value or
   `undefined` — whether Claude Code sent a progress token.

8. Optional control, only if step 6 passed with a token present: in another new
   session, ask for `sleep` with `minutes 35` and `progress false`. If that call dies
   near 30 minutes, the progress notifications are what keep a long dispatch alive.

**Verdict:** S1 **passes** only if all three hold — the call backgrounded within about
2.5 minutes; it survived the full 40 minutes; the model woke by itself with the
result. A missing progress token is fine if the call still survived. Otherwise S1
**fails**, and `dispatch` needs the job/`wait` fallback (plan Task 14).

Clean up: `claude mcp remove catherd-s1 --scope user`. Keep `spikes/s1/server.mjs` in
the repository — re-run this check on new Claude Code releases.

## S2 — symlinked agent files in a fresh session

**What this checks:** two things `writeClaudeAgents` depends on — whether retargeting
an already-registered agent's symlink changes its behavior live (S2a), and whether a
*symlinked directory* under `~/.claude/agents/` is scanned at all, and under which name
(S2b).

1. Make the probe files:

   ```bash
   mkdir -p ~/.config/catherd-s2/dir
   cat > ~/.config/catherd-s2/alpha.md <<'MD'
   ---
   name: catherd-s2-probe
   description: Spike S2 probe. Use only when explicitly asked to run catherd-s2-probe.
   model: haiku
   effort: low
   ---
   Reply with exactly one word: ALPHA
   MD
   cat > ~/.config/catherd-s2/bravo.md <<'MD'
   ---
   name: catherd-s2-probe
   description: Spike S2 probe. Use only when explicitly asked to run catherd-s2-probe.
   model: haiku
   effort: low
   ---
   Reply with exactly one word: BRAVO
   MD
   cat > ~/.config/catherd-s2/dir/catherd-s2-dirprobe.md <<'MD'
   ---
   name: catherd-s2-dirprobe
   description: Spike S2 directory probe. Use only when explicitly asked to run catherd-s2-dirprobe.
   model: haiku
   effort: low
   ---
   Reply with exactly one word: DELTA
   MD
   ln -s ~/.config/catherd-s2/alpha.md ~/.claude/agents/catherd-s2-probe.md
   ln -s ~/.config/catherd-s2/dir ~/.claude/agents/catherd-s2-dir
   ```

2. Start a **new** Claude Desktop session in the Code tab, then send:

   > Run Agent with subagent_type "catherd-s2-probe" and the prompt "go", and tell me
   > its reply word.

   Look for: `ALPHA`.

3. In a terminal, retarget the symlink without touching the session:

   ```bash
   ln -sfn ~/.config/catherd-s2/bravo.md ~/.claude/agents/catherd-s2-probe.md
   ```

4. In the **same** session, send: "Run it again, same subagent_type, and tell me the
   reply word." `BRAVO` means S2a is live (a symlink retarget changes behavior without
   a new session); `ALPHA` means it is not.

5. In the same session, send: `Run Agent with subagent_type "catherd-s2-dirprobe" and
   the prompt "go".` If it is not found, try again with
   `catherd-s2-dir:catherd-s2-dirprobe`. Also open `/agents` and note how the directory
   probe is listed, if at all. S2b passes only if the probe runs under the bare name
   `catherd-s2-dirprobe`.

6. Clean up:

   ```bash
   rm ~/.claude/agents/catherd-s2-probe.md ~/.claude/agents/catherd-s2-dir
   rm -r ~/.config/catherd-s2
   ```

**Record:** S2a live yes/no; S2b scanned yes/no, and the name it registered under. S2b
decides whether `writeClaudeAgents` can symlink one directory per profile instead of
one file per agent. S2a changes no code either way (an agent's file name and `name`
already encode its role, model and effort, so retargeting its link changes nothing
observable) — it only tells you whether a Claude Code release picked up new files
mid-session, in which case the setup skill's "new session" language can be dropped.

## Task 13 — the plugin in a fresh Claude Desktop session

**What this checks:** that Claude Code actually loads this plugin, starts the MCP
server, registers the generated Claude agents, and that both skills run through the
real tools — the thing the unit and contract tests cannot show.

1. Point the plugin at your local checkout instead of the published package (do not
   commit this edit):

   ```bash
   cd <your catherd checkout>
   bun -e '
   const fs = require("fs");
   const f = "plugin/.mcp.json";
   const j = JSON.parse(fs.readFileSync(f, "utf8"));
   j.mcpServers.catherd = { command: "bun", args: [process.cwd() + "/src/cli.ts", "mcp"] };
   fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
   '
   ```

2. Install from the local marketplace:

   ```bash
   claude plugin marketplace add "$PWD"
   claude plugin install catherd@catherd
   ```

   Then make sure the real profile's agent files exist, so Claude Code can see them at
   session start:

   ```bash
   bun -e 'import { saveProfileAndAgents } from "./src/profile/agents.ts"; import { loadProfile } from "./src/profile/profile.ts"; import { loadCatalog } from "./src/routing/catalog.ts"; console.log(saveProfileAndAgents(loadProfile(), loadCatalog()));'
   ls -l ~/.claude/agents/catherd-*
   ```

   Look for: the architect and verifier links in that listing.

3. Start a **new** session in the Code tab, in a small throwaway git repository, and
   check, one at a time:

   1. Type `/`. Look for: both `/catherd` and `/catherd-setup` listed once each. If
      Claude Code reports a clash between `plugin/commands/catherd.md` and
      `plugin/skills/catherd/`, or lists one of them twice, that is a defect against
      the design (skills are already slash-invocable on their own) — record it before
      deciding whether to drop `plugin/commands/`.
   2. Ask: "List the catherd MCP tools you have." Look for: all eighteen tool names
      (`run_start, write_run_file, read_run_file, status, result, set_next, route,
      climb, ask, land, read_knowledge, dispatch, catalog_query, profile_get,
      profile_validate, profile_set, runs_summary, preflight`).
   3. Ask: "Call the catherd status tool." Look for: `catherd: no runs yet`, or the
      runs already on this machine.
   4. Ask: "Which catherd agents can you run?" Look for: both
      `catherd-architect-claude-opus-5-5-high` and
      `catherd-verifier-claude-opus-5-5-low` in the list.
   5. Run `/catherd-setup`. Look for: one question at a time, each with a recommended
      answer; stop it after two answers.
   6. In a repo with a one-file hello script and a test, run `/catherd Add a --shout
      flag to the hello script that upper-cases its output`. Look for: A-lines,
      `run_start`, lane files written through `write_run_file` (no permission prompt
      for the run folder, since it is outside the repo), `route`, a worker `dispatch`,
      the verifier running as the generated agent, a `land`, and a final report with
      the harness line. If S1 passed, the dispatch backgrounds after two minutes only
      if the role actually runs that long — a quicker finish is fine.

4. Restore and clean up:

   ```bash
   git checkout plugin/.mcp.json
   claude plugin uninstall catherd@catherd
   claude plugin marketplace remove catherd
   ```

5. Record what each check showed, and file a defect (with its own automated test, in
   the owning task's files) for anything that did not match.
