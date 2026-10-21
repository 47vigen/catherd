import { headerLine } from "./lane.ts";
import { slug } from "./util.ts";
import { BaseRefSchema } from "./workspace.ts";

/** The run title as a folder and branch stem: at most 40 characters, `run` when nothing is left. */
export const runSlug = (title: string): string => slug(title).slice(0, 40) || "run";

/** A milestone's branch: the run's slug and the milestone, lower case (`wallet-split-m1`). */
export const milestoneBranch = (title: string, m: string): string => `${runSlug(title)}-${m.toLowerCase()}`;

/** A branch on origin as `run_start`'s base: a plain name, never a remote ref (`origin/…`) or a full ref. */
export const BaseBranchSchema = BaseRefSchema.refine(
  (s) => !s.startsWith("origin/") && !s.startsWith("refs/"),
);

/**
 * The `Setup:` command in the lines right under plan.md's `# ` title, up to the first blank line or heading
 * (backticks stripped); null without one. A blank line after the title ends the header, so body prose never counts.
 */
export function planSetup(planText: string): string | null {
  const lines = planText.split("\n");
  const start = lines.findIndex((l) => /^#\s+/.test(l)) + 1;
  let end = start;
  while (end < lines.length && (lines[end] ?? "").trim() !== "" && !(lines[end] ?? "").startsWith("#")) end++;
  const re = headerLine("setup");
  for (const line of lines.slice(start, end)) {
    const m = re.exec(line);
    if (m)
      return (
        (m[1] ?? "")
          .trim()
          .replace(/^`+|`+$/g, "")
          .trim() || null
      );
  }
  return null;
}

/** Whether the owner's answer to a landed milestone's question is the word that has catherd push its branch. */
export const isPushAnswer = (answer: string): boolean => answer.trim().toLowerCase() === "push";

/** The command that opens a milestone's MR, for the origin's host: gh on github.com, else glab. */
export function mrCommand(o: { originUrl: string; base: string; branch: string; body: string }): string {
  return /(^|[@/.])github\.com[:/]/.test(o.originUrl)
    ? `gh pr create --base ${o.base} --head ${o.branch} --body-file ${o.body}`
    : `glab mr create --source-branch ${o.branch} --target-branch ${o.base} --description-file ${o.body}`;
}

/** The milestone a unit (`run`, `M1`, `M1.L2`) belongs to; null for the run itself. */
export const unitMilestone = (unit: string): string | null =>
  unit === "run" ? null : (unit.split(".")[0] ?? null);
