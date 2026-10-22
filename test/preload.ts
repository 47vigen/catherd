// Loaded before every test file (bunfig.toml). The MCP server's boot sync and `init`'s sync would fetch the
// public sources (spec 1.2 §3.2); no test may reach the network, and every process a test starts with its
// env inherits this. A test of the sync itself deletes it and injects a fetch.
process.env.CATHERD_NO_SYNC = "1";
// Plan 22: a detached supervisor whose run a Codex thread owns pushes the role's notice itself, after a grace;
// in tests it would outlive its test. A test of that push deletes it.
process.env.CATHERD_NO_END_PUSH = "1";
// A catherd worker runs this suite with its own catherd's data and config dirs in the env (movedHomeEnv); they win
// over CATHERD_HOME, so a test that sets only CATHERD_HOME would write into the real ones.
delete process.env.CATHERD_DATA_DIR;
delete process.env.CATHERD_CONFIG_DIR;
// Heavy slots wait while the host load is above twice its cores (up to 15 minutes). A CI runner running the suite
// is that busy, so no lock in a test, nor any `catherd lock` a test spawns, may wait on it. A test of the wait sets
// heavyLimits.loadWaitMs itself.
process.env.CATHERD_HEAVY_LOAD_WAIT_MS = "0";
// The suite runs under `catherd lock -- bun test`, which marks its command as already locked; a test that spawns
// `catherd lock` or runs a milestone check would then skip the slot logic it tests.
delete process.env.CATHERD_LOCK_HELD;
// A run's daemon runs until its run ends: one a test started for a run it never finished would outlive the suite
// (25 orphans after a few runs). No test spawns one; a test of the launch itself calls launchDaemon directly.
// (imported after the env above: heavy-lock reads its limits from it when it loads)
const { daemonLauncher } = await import("../src/services/daemon.ts");
daemonLauncher.launch = () => 0;

export {};
