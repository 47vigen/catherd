import { z } from "zod";

export const TokensSchema = z.object({ input: z.number(), cached: z.number(), output: z.number() });

/** `line` is the item's 0-based line index in the role's stream. */
const line = z.number().int();

/** One thing a role did, read from its stream; the UI merges items by `id` (a later one replaces, an `output` fills). */
export const TranscriptItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), line, text: z.string() }),
  z.object({ kind: z.literal("thinking"), line, text: z.string() }),
  z.object({
    kind: z.literal("tool"),
    line,
    id: z.string(),
    name: z.string(),
    input: z.string(),
    output: z.string().nullable(),
    error: z.boolean(),
  }),
  z.object({
    kind: z.literal("shell"),
    line,
    id: z.string(),
    command: z.string(),
    output: z.string().nullable(),
    exit: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("file"),
    line,
    id: z.string(),
    changes: z.array(z.object({ path: z.string(), kind: z.string() })),
    diff: z.string().nullable(),
  }),
  // fills the card with that id
  z.object({ kind: z.literal("output"), line, id: z.string(), text: z.string(), error: z.boolean() }),
  z.object({ kind: z.literal("error"), line, text: z.string() }),
  z.object({
    kind: z.literal("turn"),
    line,
    tokens: TokensSchema.nullable(),
    costUsd: z.number().nullable(),
  }),
  z.object({ kind: z.literal("raw"), line, text: z.string() }),
]);
export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;

export const TranscriptPageSchema = z.object({
  items: z.array(TranscriptItemSchema),
  raw: z.array(z.string()).nullable(),
  next: z.number().int(),
  ended: z.boolean(),
});
export type TranscriptPage = z.infer<typeof TranscriptPageSchema>;
