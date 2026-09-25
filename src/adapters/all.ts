import { claudeCodeAdapter } from "./claude-code/index.ts";
import { codexAdapter } from "./codex/index.ts";
import { registerAdapter } from "./registry.ts";

registerAdapter(codexAdapter);
registerAdapter(claudeCodeAdapter);
