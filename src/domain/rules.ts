import { ROLES, type Role } from "./roles.ts";

/** A `[role, role]` group right after `- <date> <source>: `, or at the start of a hand-edited line. */
export const RULE_TAG =
  /^(\s*(?:[-*]\s+)?(?:\d{4}-\d{2}-\d{2}\s+[^\n]*?:\s+)?)\[([a-z-]+(?:\s*,\s*[a-z-]+)*)\]\s*/;

/** The names of a tag-shaped group, whatever they are; null when the line has none. */
export function tagNames(line: string): string[] | null {
  const m = RULE_TAG.exec(line);
  return m ? (m[2] as string).split(",").map((n) => n.trim()) : null;
}

/** The roles of a tag whose every name is a role; null when the line has no tag, or a bracket group that is no tag. */
export function ruleRoles(line: string): Role[] | null {
  const names = tagNames(line);
  return names?.every((n) => (ROLES as readonly string[]).includes(n)) ? (names as Role[]) : null;
}

/** The lines of `text` that reach `role`: untagged ones whole, tagged ones for their roles with the tag removed. */
export function rulesFor(text: string, role: Role): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const roles = ruleRoles(line);
    if (!roles) out.push(line);
    else if (roles.includes(role)) out.push(line.replace(RULE_TAG, "$1"));
  }
  return out.join("\n").trim();
}

/** The standing rules as a brief section; "" when the role has none. */
export function rulesBlock(rules: string, role: Role): string {
  return rules.trim() ? `Standing rules for the ${role} role in this repo (its knowledge.md):\n${rules}` : "";
}
