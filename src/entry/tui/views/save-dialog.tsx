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
import { Dialog, dialogRows } from "../widgets/dialog.tsx";
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

/** A block of the save dialog: heading lines, then items of one or more lines each. */
interface Section {
  head: Part[][];
  items: Part[][][];
  /** whether the section gives up rows before the ones that do not */
  cut: boolean;
}

/**
 * The sections' lines in at most `rows` lines. Empty sections are left out. Over budget, the longest
 * cuttable section loses its last item until everything fits (then the others); a cut section ends
 * with one muted "… and N more" line.
 */
export function fitSections(sections: Section[], rows: number): Part[][] {
  const shown = sections.filter((s) => s.items.length > 0);
  const keep = shown.map((s) => s.items.length);
  const size = (i: number) => {
    const s = shown[i]!;
    const body = s.items.slice(0, keep[i]).reduce((n, it) => n + it.length, 0);
    return s.head.length + body + (keep[i]! < s.items.length ? 1 : 0);
  };
  const total = () => shown.reduce((n, _, i) => n + size(i), 0);
  for (const cut of [true, false])
    while (total() > rows) {
      let at = -1;
      for (const [i, s] of shown.entries())
        if (s.cut === cut && keep[i]! > 0 && (at < 0 || size(i) > size(at))) at = i;
      if (at < 0) break;
      keep[at]! -= 1;
    }
  const out = shown.flatMap((s, i) => {
    const more = s.items.length - keep[i]!;
    return [
      ...s.head,
      ...s.items.slice(0, keep[i]).flat(),
      ...(more > 0 ? [[{ text: `… and ${more} more`, tone: "muted" as const }]] : []),
    ];
  });
  return out.slice(0, Math.max(0, rows));
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
    const repo = data.profiles.value?.repo;
    const issues = [
      ...preview.validation.errors.map((e) => ({ ...e, state: "fail" as const })),
      ...preview.validation.warnings.map((w) => ({ ...w, state: "warn" as const })),
    ];
    const text = (t: string, tone: Part["tone"]): Part[][] => wrap(t, inner).map((l) => [{ text: l, tone }]);
    const sections: Section[] = [
      {
        head: [],
        cut: true,
        items: [
          ...preview.changes.map((c): Part[][] => [
            [
              { text: `${c.path}  ` },
              { text: show(c.before), tone: "diffDel" },
              { text: ` ${glyph("arrow", ui.plain)} ` },
              { text: show(c.after), tone: "diffAdd" },
            ],
          ]),
          ...preview.treatLikes.map(([rung, like]): Part[][] => [
            [{ text: `treat ${rung} like ` }, { text: like, tone: "diffAdd" }],
          ]),
        ],
      },
      {
        head: [[]],
        cut: true,
        items: issues.map((i) =>
          text(
            `${glyph(i.state, ui.plain)} ${i.path}: ${i.message}`,
            i.state === "fail" ? "error" : "warning",
          ),
        ),
      },
      {
        head: [[], [{ text: "Agent files", bold: true }]],
        cut: true,
        items: [
          ...preview.agentsAdded.map((a): Part[][] => [[{ text: `+ ${a}`, tone: "diffAdd" }]]),
          ...preview.agentsRemoved.map((a): Part[][] => [[{ text: `- ${a}`, tone: "diffDel" }]]),
        ],
      },
      {
        head: [[]],
        cut: false,
        items: [
          text(
            "Applies to: native Claude agents in new Claude Code sessions; codex, claude-code and opencode from the next dispatch.",
            "muted",
          ),
          // inside a bound repo, making a profile active binds the repo to it (the button keeps §9.2's label)
          ...(repo ? [text(`Save & make active binds ${repo} to ${name}.`, "muted")] : []),
        ],
      },
      { head: [[]], cut: false, items: props.dialog.error ? [text(props.dialog.error, "error")] : [] },
    ];
    // the gap and the buttons always fit: every section shares what is left of the panel
    fitSections(sections, dialogRows(dims.height) - 2).forEach((p, i) => line(`r${i}`, p));
    line("gap5", []);
    out.push(
      <Buttons key="buttons" labels={labels} focused={Math.min(focused, labels.length - 1)} width={inner} />,
    );
    return out;
  };
  return <Dialog title={`Save profile ${name}`} size="large" rows={rows} />;
}
