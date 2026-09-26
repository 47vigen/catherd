import type { DiscoveredModel } from "../backend.ts";
import { CLAUDE_ALIASES, CLAUDE_EFFORTS, CLAUDE_MODELS } from "./models.ts";

export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";

interface ApiModel {
  id?: unknown;
  max_input_tokens?: unknown;
  capabilities?: {
    image_input?: { supported?: unknown };
    effort?: Record<string, { supported?: unknown } | unknown>;
  };
}

const supported = (v: unknown) => (v as { supported?: unknown } | undefined)?.supported === true;

function fromApi(m: ApiModel): DiscoveredModel | null {
  if (typeof m.id !== "string" || !m.id.startsWith("claude-") || m.id in CLAUDE_ALIASES) return null;
  const known = CLAUDE_MODELS.find((k) => k.id === m.id);
  const effort = m.capabilities?.effort;
  return {
    id: m.id,
    // a model without effort support lists no effort, so its only rung is #default (Haiku 4.5)
    efforts: effort ? CLAUDE_EFFORTS.filter((e) => supported(effort[e])) : [...(known?.efforts ?? [])],
    context: typeof m.max_input_tokens === "number" ? m.max_input_tokens : (known?.context ?? null),
    imageIn: m.capabilities?.image_input ? supported(m.capabilities.image_input) : (known?.imageIn ?? false),
  };
}

/**
 * Spec §5.2: Claude's models are the shipped list, refreshed from the Models API when an Anthropic API
 * key is present. The API's entries win; shipped models it does not list stay (a Claude plan login may
 * reach models an API key does not). Any failure keeps the shipped list.
 */
export async function listClaudeModels(
  o: { key?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DiscoveredModel[]> {
  const shipped = CLAUDE_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }));
  const key = o.key === undefined ? process.env.ANTHROPIC_API_KEY?.trim() || null : o.key;
  if (!key) return shipped;
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const listed: DiscoveredModel[] = [];
  let after: string | null = null;
  try {
    for (let page = 0; page < 20; page++) {
      const url = `${ANTHROPIC_MODELS_URL}?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
      const res = await fetchImpl(url, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
      if (!res.ok) return shipped;
      const body = (await res.json()) as { data?: ApiModel[]; has_more?: unknown; last_id?: unknown };
      for (const m of body.data ?? []) {
        const d = fromApi(m);
        if (d) listed.push(d);
      }
      if (body.has_more !== true || typeof body.last_id !== "string") break;
      after = body.last_id;
    }
  } catch {
    return shipped;
  }
  if (listed.length === 0) return shipped;
  return [...listed, ...shipped.filter((s) => !listed.some((l) => l.id === s.id))];
}
