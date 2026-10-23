import type { Attempt, RunModel, RunNode } from "../../../../client";

export interface CommitRef {
  sha: string;
  label: string;
}

/**
 * The commits whose diff a node's Changes tab shows. A commit or land node shows every round of its milestone's
 * commit, newest first. A lane shows the one of the round it is looking at (the commit is per milestone; the diff is
 * filtered to the lane's files). Other nodes have none.
 */
export function commitsFor(model: RunModel, node: RunNode, attempt: Attempt | undefined): CommitRef[] {
  if (node.kind !== "commit" && node.kind !== "land" && node.kind !== "lane") return [];
  const commit = model.nodes.find((n) => n.kind === "commit" && n.milestone === node.milestone);
  const all = (commit?.attempts ?? []).flatMap((a) => (a.commit ? [{ sha: a.commit, label: a.label }] : []));
  if (node.kind !== "lane") return all;
  const same = all.find((c) => c.label === attempt?.label);
  const one = same ?? all[0];
  return one ? [one] : [];
}
