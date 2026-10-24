const WORD: Record<string, string> = { deepseek: "DeepSeek", gpt: "GPT", glm: "GLM" };
const ACRONYM = new Set(["gpt", "glm"]);

/** A model as people say it, from a model id, a provider path or a rung: `openscale/deepseek/deepseek-v4.1-flash` is
 * "DeepSeek V4.1 Flash", `codex:gpt-6-luna#high` "GPT-6 Luna", `claude-sonnet-4-5-20250929` "Claude Sonnet 4.5". */
export function modelName(idOrRung: string): string {
  // The backend prefix ends at a colon that comes before any slash (`ollama/qwen3:8b` keeps its colon).
  const id = (
    idOrRung
      .replace(/^[^:/]*:/, "")
      .replace(/#.*$/, "")
      .split("/")
      .pop() ?? ""
  ).trim();
  const out: string[] = [];
  // A dated snapshot suffix ("-20250929") is noise in a label.
  for (const part of id.split(/[-_]/).filter((p) => p && !/^\d{6,}$/.test(p))) {
    const prev = out.at(-1);
    if (prev !== undefined && /^\d+(\.\d+)*$/.test(part)) {
      // A number after a number is its minor ("5-5" is 5.5); after GPT or GLM it joins with a dash (GPT-6).
      if (/\d$/.test(prev)) out[out.length - 1] = `${prev}.${part}`;
      else if (ACRONYM.has(prev.toLowerCase())) out[out.length - 1] = `${prev}-${part}`;
      else out.push(part);
    } else out.push(WORD[part.toLowerCase()] ?? part.charAt(0).toUpperCase() + part.slice(1));
  }
  return out.join(" ") || idOrRung;
}
