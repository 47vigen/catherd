import type { DiscoveredModel } from "../backend.ts";

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Spec §5.2: Claude's models come from a shipped list (Claude Code has no model listing; research
 * 2026-09-25-models.md §1.1). Full ids only: an alias resolves differently per provider.
 */
export const CLAUDE_MODELS: DiscoveredModel[] = [
  { id: "claude-fable-5-1", efforts: CLAUDE_EFFORTS, context: 1_000_000, imageIn: true },
  { id: "claude-opus-5-5", efforts: CLAUDE_EFFORTS, context: 1_000_000, imageIn: true },
  { id: "claude-sonnet-5", efforts: CLAUDE_EFFORTS, context: 1_000_000, imageIn: true },
  { id: "claude-haiku-4-5-20251001", efforts: [], context: 200_000, imageIn: true },
];

/** Claude Code aliases and dateless short ids that name a different model per provider or over time. */
export const CLAUDE_ALIASES: Record<string, string> = {
  fable: "claude-fable-5-1",
  best: "claude-fable-5-1",
  opus: "claude-opus-5-5",
  opusplan: "claude-opus-5-5",
  default: "claude-opus-5-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};
