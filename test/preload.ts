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
