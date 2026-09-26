import { useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useMemo, useState } from "react";
import { type Change, diffProfiles, resolveProfile } from "../../../domain/profile.ts";
import type { Validation } from "../../../domain/profile-rules.ts";
import type { Effects } from "../effects.ts";
import { useApp } from "../providers/app.tsx";
import { useData } from "../providers/data.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import { useUi } from "../providers/theme.tsx";
import { withStaged } from "../profile-tree.ts";
import type { Dialog as DialogState, Draft } from "../state.ts";
import { wrap } from "../text.ts";
import { glyph } from "../theme.ts";
import { Buttons } from "../widgets/dialog-confirm.tsx";
import { Dialog } from "../widgets/dialog.tsx";
import { Line, type Part } from "../widgets/line.tsx";

type Save = Extract<DialogState, { kind: "save" }>;

const show = (v: unknown): string =>
  v === null || v === undefined ? "none" : Array.isArray(v) ? v.join(", ") : String(v);

/** What saving a draft would do: the changed fields, staged treat-likes, issues, and agent changes. */
export interface SavePreview {
  changes: Change[];
  treatLikes: [string, string][];
  validation: Validation;
  agentsAdded: string[];
  agentsRemoved: string[];
}

export function previewSave(d: Draft, fx: Pick<Effects, "catalog" | "validate" | "agents">): SavePreview {
  const before = resolveProfile(d.base, d.name);
  const after = resolveProfile(d.doc, d.name);
  const { catalog } = fx.catalog(after.billing);
  const a = new Set(fx.agents(before));
  const b = new Set(fx.agents(after));
  return {
    changes: diffProfiles(before, after),
    treatLikes: Object.entries(d.treatLikes),
    validation: fx.validate(after, withStaged(catalog, d.treatLikes)),
    agentsAdded: [...b].filter((x) => !a.has(x)),
    agentsRemoved: [...a].filter((x) => !b.has(x)),
  };
}

/**
 * Spec §9.2: ctrl+s opens this, never enter. It shows the diff, the agent-file changes and what applies
 * when, with Save, Save & make active and Cancel; errors leave only Cancel.
 */
export function SaveDialog(props: { dialog: Save }) {
  const app = useApp();
  const data = useData();
  const ui = useUi();
  const dims = useTerminalDimensions();
  const name = props.dialog.purpose.name;
  const draft = app.state.drafts[name];
  const preview = useMemo(() => (draft ? previewSave(draft, app.effects) : null), [draft, app.effects]);
  const blocked = (preview?.validation.errors.length ?? 1) > 0;
  // spec §9.2's order: Save / Save & make active / Cancel; errors leave only Cancel
  const labels = blocked ? ["Cancel"] : ["Save", "Save & make active", "Cancel"];
  const [focused, setFocused] = useState(0);
  useCommandLayer("dialog", {
    "dialog.left": () => setFocused((f) => Math.max(0, f - 1)),
    "dialog.right": () => setFocused((f) => Math.min(labels.length - 1, f + 1)),
    "dialog.submit": () => {
      const label = labels[Math.min(focused, labels.length - 1)];
      if (label === "Save") app.answer("save");
      else if (label === "Save & make active") app.answer("activate");
      else app.dispatch({ type: "close" });
    },
  });
  const rows = (inner: number): ReactNode[] => {
    const out: ReactNode[] = [];
    const line = (key: string, parts: Part[]) => out.push(<Line key={key} width={inner} parts={parts} />);
    if (!preview) {
      line("gone", [{ text: "Nothing to save.", tone: "muted" }]);
      return out;
    }
    const budget = Math.max(4, Math.floor(dims.height / 2) - 4);
    const changes: Part[][] = [
      ...preview.changes.map((c): Part[] => [
        { text: `${c.path}  ` },
        { text: show(c.before), tone: "diffDel" },
        { text: ` ${glyph("arrow", ui.plain)} ` },
        { text: show(c.after), tone: "diffAdd" },
      ]),
      ...preview.treatLikes.map(([rung, like]): Part[] => [
        { text: `treat ${rung} like ` },
        { text: like, tone: "diffAdd" },
      ]),
    ];
    changes.slice(0, budget).forEach((p, i) => line(`c${i}`, p));
    if (changes.length > budget)
      line("more", [{ text: `… and ${changes.length - budget} more`, tone: "muted" }]);
    const issues = [
      ...preview.validation.errors.map((e) => ({ ...e, state: "fail" as const })),
      ...preview.validation.warnings.map((w) => ({ ...w, state: "warn" as const })),
    ];
    if (issues.length) line("gap1", []);
    issues
      .slice(0, 4)
      .forEach((i, n) =>
        wrap(`${glyph(i.state, ui.plain)} ${i.path}: ${i.message}`, inner).forEach((l, j) =>
          line(`i${n}-${j}`, [{ text: l, tone: i.state === "fail" ? "error" : "warning" }]),
        ),
      );
    if (issues.length > 4) line("imore", [{ text: `… and ${issues.length - 4} more`, tone: "muted" }]);
    if (preview.agentsAdded.length || preview.agentsRemoved.length) {
      line("gap2", []);
      line("agents", [{ text: "Agent files", bold: true }]);
      for (const a of preview.agentsAdded) line(`+${a}`, [{ text: `+ ${a}`, tone: "diffAdd" }]);
      for (const a of preview.agentsRemoved) line(`-${a}`, [{ text: `- ${a}`, tone: "diffDel" }]);
    }
    line("gap3", []);
    for (const [i, l] of wrap(
      "Applies to: native Claude agents in new Claude Code sessions; codex, claude-code and opencode from the next dispatch.",
      inner,
    ).entries())
      line(`a${i}`, [{ text: l, tone: "muted" }]);
    // inside a bound repo, making a profile active binds the repo to it (the button keeps §9.2's label)
    const repo = data.profiles.value?.repo;
    if (repo)
      for (const [i, l] of wrap(`Save & make active binds ${repo} to ${name}.`, inner).entries())
        line(`r${i}`, [{ text: l, tone: "muted" }]);
    if (props.dialog.error) {
      line("gap4", []);
      for (const [i, l] of wrap(props.dialog.error, inner).entries())
        line(`e${i}`, [{ text: l, tone: "error" }]);
    }
    line("gap5", []);
    out.push(
      <Buttons key="buttons" labels={labels} focused={Math.min(focused, labels.length - 1)} width={inner} />,
    );
    return out;
  };
  return <Dialog title={`Save profile ${name}`} size="large" rows={rows} />;
}
