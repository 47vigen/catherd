import { claudeCodeAdapter } from "./claude-code/index.ts";
import { codexAdapter } from "./codex/index.ts";
import { cursorAdapter } from "./cursor/index.ts";
import { grokAdapter } from "./grok/index.ts";
import { opencodeAdapter } from "./opencode/index.ts";
import { registerAdapter } from "./registry.ts";

registerAdapter(codexAdapter);
registerAdapter(claudeCodeAdapter);
registerAdapter(opencodeAdapter);
registerAdapter(cursorAdapter);
registerAdapter(grokAdapter);
