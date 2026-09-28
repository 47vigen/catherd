// Loaded before every test file (bunfig.toml). The MCP server's boot sync and `init`'s sync would fetch the
// public sources (spec 1.2 §3.2); no test may reach the network, and every process a test starts with its
// env inherits this. A test of the sync itself deletes it and injects a fetch.
process.env.CATHERD_NO_SYNC = "1";
