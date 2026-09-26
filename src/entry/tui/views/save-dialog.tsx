import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  applyPatch,
  type Change,
  diffProfiles,
  patchBetween,
  resolveProfile,
} from "../../../domain/profile.ts";
import type { Validation } from "../../../domain/profile-rules.ts";
import type { Effects } from "../effects.ts";
import { useApp } from "../providers/app.tsx";
import { useData, useLoad } from "../providers/data.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import { useUi } from "../providers/theme.tsx";
import { withStaged } from "../profile-tree.ts";
import { type Dialog as DialogState, type Draft, isSaving } from "../state.ts";
import { wrap } from "../text.ts";
import { glyph } from "../theme.ts";
import { Buttons } from "../widgets/dialog-confirm.tsx";
import { Dialog, dialogRows } from "../widgets/dialog.tsx";
import { Line, type Part } from "../widgets/line.tsx";

type Save = Extract<DialogState, { kind: "save" }>;

/** Said when a Save found the file changed since the dialog showed what saving would do. */
const CHANGED_ON_DISK = "the profile changed on disk — check the changes and choose again";

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

/**
 * The save is a patch over the file as it is when it is written (Ruling 7), so the preview applies the
 * draft's patch to the file as it is now, not to the copy the draft began from.
 */
export function previewSave(
  d: Draft,
  fx: Pick<Effects, "catalog" | "validate" | "agents" | "readProfile">,
): SavePreview {
  const now = fx.readProfile(d.name);
  const before = resolveProfile(now, d.name);
  const after = resolveProfile(applyPatch(now, patchBetween(d.base, d.doc)), d.name);
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
  /**
   * How long the section holds on when rows run short (spec §9.2, Ruling 8):
   * "filler" (changes, warnings, agent files) loses items first, then goes whole;
   * "note" (what applies when) goes whole, never in part;
   * "error" (validation errors) loses items only after both, and keeps its first;
   * "failure" (why the last save failed) is never cut.
   */
  hold: "filler" | "note" | "error" | "failure";
  /** the line that ends a cut section; "… and N more" when unset */
  more?: (n: number) => string;
}

const HOLD = { filler: 0, note: 1, error: 2, failure: 3 } as const;

/**
 * The sections' lines in at most `rows` lines. Empty sections are left out. Over budget, in turn:
 * the longest filler section loses its last item (a cut section ends with one muted "… and N more"
 * line); filler and note sections go whole, the least-held first; error sections lose items down
 * to their first; last, lines come off the end of every section but the failure, then the failure.
 */
export function fitSections(sections: Section[], rows: number): Part[][] {
  const shown = sections.filter((s) => s.items.length > 0);
  const keep = shown.map((s) => s.items.length);
  const gone = shown.map(() => false);
  const size = (i: number) => {
    if (gone[i]) return 0;
    const s = shown[i]!;
    const body = s.items.slice(0, keep[i]).reduce((n, it) => n + it.length, 0);
    return s.head.length + body + (keep[i]! < s.items.length ? 1 : 0);
  };
  const total = () => shown.reduce((n, _, i) => n + size(i), 0);
  /** the largest live section `ok` accepts, or -1 */
  const largest = (ok: (s: Section, i: number) => boolean) => {
    let at = -1;
    for (const [i, s] of shown.entries()) if (!gone[i] && ok(s, i) && (at < 0 || size(i) > size(at))) at = i;
    return at;
  };
  for (let at; total() > rows && (at = largest((s, i) => s.hold === "filler" && keep[i]! > 0)) >= 0;)
    keep[at]! -= 1;
  for (const hold of ["filler", "note"] as const)
    for (let at; total() > rows && (at = largest((s) => s.hold === hold)) >= 0;) gone[at] = true;
  for (let at; total() > rows && (at = largest((s, i) => s.hold === "error" && keep[i]! > 1)) >= 0;)
    keep[at]! -= 1;
  const lines = shown.map((s, i) => {
    if (gone[i]) return [];
    const more = s.items.length - keep[i]!;
    const tail = s.more?.(more) ?? `… and ${more} more`;
    return [
      ...s.head,
      ...s.items.slice(0, keep[i]).flat(),
      ...(more > 0 ? [[{ text: tail, tone: "muted" as const }]] : []),
    ];
  });
  // still over: the blank lines between sections go, then lines come off the end of the least-held
  // sections, the failure last
  let over = lines.reduce((n, l) => n + l.length, 0) - Math.max(0, rows);
  const order = shown.map((_, i) => i).sort((x, y) => HOLD[shown[x]!.hold] - HOLD[shown[y]!.hold]);
  for (const i of order)
    while (over > 0 && lines[i]![0]?.length === 0 && shown[i]!.head.length > 0 && !gone[i]) {
      lines[i]!.shift();
      over -= 1;
    }
  for (const i of order) {
    const off = Math.min(over, lines[i]!.length);
    lines[i]!.splice(lines[i]!.length - off, off);
    over -= off;
  }
  return lines.flat();
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
  const renderer = useRenderer();
  const name = props.dialog.purpose.name;
  const draft = app.state.drafts[name];
  // the preview reads the catalog and agent files: off the render path, so a read that throws is shown
  // here as the reason nothing can be saved, not as a broken screen
  const key = draft ? JSON.stringify([draft.doc, draft.treatLikes]) : "";
  const loaded = useLoad(() => (draft ? previewSave(draft, app.effects) : null), key);
  // a Save re-reads the file: when that changed what saving would do, the dialog shows the new preview
  // in place of the loaded one and asks again (another process may have written the profile meanwhile)
  const [fresh, setFresh] = useState<{ key: string; value: SavePreview | null; error: string | null } | null>(
    null,
  );
  const shown = fresh?.key === key ? fresh : loaded;
  const preview = shown.value;
  const error = shown.error;
  // what the dialog shows now, for keys in one burst
  const shownRef = useRef<SavePreview | null>(preview);
  shownRef.current = preview;
  // set when a Save replaces the preview, cleared by the first frame drawn to the terminal after the
  // commit that holds the new one: a Save between the two (a later key in the same burst) would answer a
  // preview nobody has seen. React may commit between two keys of one burst, so a commit is not enough.
  const unseenRef = useRef(false);
  useEffect(() => {
    if (!unseenRef.current) return;
    const seen = () => {
      unseenRef.current = false;
    };
    renderer.once("frame", seen);
    renderer.requestRender();
    return () => {
      renderer.off("frame", seen);
    };
  }, [fresh, renderer]);
  const [changed, setChanged] = useState(false);
  const blocked = error !== null || (preview?.validation.errors.length ?? 0) > 0;
  // spec §9.2's order: Save / Save & make active / Cancel; errors leave only Cancel
  const labels = blocked ? ["Cancel"] : ["Save", "Save & make active", "Cancel"];
  const [focused, setFocusedState] = useState(0);
  // keys in one burst read the focus as it is now, not as it was drawn
  const focusedRef = useRef(0);
  const setFocused = (f: number) => {
    focusedRef.current = f;
    setFocusedState(f);
  };
  useCommandLayer("dialog", {
    "dialog.left": () => setFocused(Math.max(0, focusedRef.current - 1)),
    "dialog.right": () => setFocused(Math.min(labels.length - 1, focusedRef.current + 1)),
    "dialog.submit": () => {
      // a save that is writing takes no answer
      if (isSaving(app.getState())) return;
      const label = labels[Math.min(focusedRef.current, labels.length - 1)];
      // nothing is saved before its diff has been shown
      if (label !== "Cancel" && (!shownRef.current || unseenRef.current)) return;
      if (label !== "Cancel") {
        // only the save the dialog shows is made: the file is read again now, and a different preview
        // replaces the shown one and asks again instead of saving
        const d = app.getState().drafts[name];
        let now: SavePreview | null = null;
        let failed: string | null = null;
        try {
          now = d ? previewSave(d, app.effects) : null;
        } catch (e) {
          failed = e instanceof Error ? e.message : String(e);
        }
        if (failed !== null || JSON.stringify(now) !== JSON.stringify(shownRef.current)) {
          shownRef.current = now;
          unseenRef.current = true;
          setFresh({ key, value: now, error: failed });
          setChanged(true);
          return;
        }
      }
      if (label === "Save") app.answer("save");
      else if (label === "Save & make active") app.answer("activate");
      else app.dispatch({ type: "close" });
    },
  });
  const rows = (inner: number): ReactNode[] => {
    const out: ReactNode[] = [];
    const line = (key: string, parts: Part[]) => out.push(<Line key={key} width={inner} parts={parts} />);
    if (error !== null) {
      wrap(`Cannot show what saving would do: ${error}`, inner).forEach((t, i) =>
        line(`fail${i}`, [{ text: t, tone: "error" }]),
      );
      line("gap", []);
      out.push(<Buttons key="buttons" labels={labels} focused={0} width={inner} />);
      return out;
    }
    if (!preview) {
      line("gone", [{ text: draft ? "reading…" : "Nothing to save.", tone: "muted" }]);
      return out;
    }
    const repo = data.profiles.value?.repo;
    const text = (t: string, tone: Part["tone"]): Part[][] => wrap(t, inner).map((l) => [{ text: l, tone }]);
    const sections: Section[] = [
      {
        head: [],
        hold: "filler",
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
        hold: "error",
        more: (n) => `… and ${n} more ${n === 1 ? "error" : "errors"}`,
        items: preview.validation.errors.map((e) =>
          text(`${glyph("fail", ui.plain)} ${e.path}: ${e.message}`, "error"),
        ),
      },
      {
        // warnings follow the errors in one block
        head: preview.validation.errors.length ? [] : [[]],
        hold: "filler",
        more: (n) => `… and ${n} more ${n === 1 ? "warning" : "warnings"}`,
        items: preview.validation.warnings.map((w) =>
          text(`${glyph("warn", ui.plain)} ${w.path}: ${w.message}`, "warning"),
        ),
      },
      {
        head: [[], [{ text: "Agent files", bold: true }]],
        hold: "filler",
        items: [
          ...preview.agentsAdded.map((a): Part[][] => [[{ text: `+ ${a}`, tone: "diffAdd" }]]),
          ...preview.agentsRemoved.map((a): Part[][] => [[{ text: `- ${a}`, tone: "diffDel" }]]),
        ],
      },
      {
        head: [[]],
        hold: "note",
        items: [
          text(
            "Applies to: native Claude agents in new Claude Code sessions; codex, claude-code and opencode from the next dispatch.",
            "muted",
          ),
          // inside a bound repo, making a profile active binds the repo to it (the button keeps §9.2's label)
          ...(repo ? [text(`Save & make active binds ${repo} to ${name}.`, "muted")] : []),
        ],
      },
      { head: [[]], hold: "failure", items: props.dialog.error ? [text(props.dialog.error, "error")] : [] },
    ];
    // the gap and the buttons always fit: every section shares what is left of the panel
    const notice =
      changed && !props.dialog.saving ? wrap(`${glyph("warn", ui.plain)} ${CHANGED_ON_DISK}`, inner) : [];
    fitSections(sections, dialogRows(dims.height) - 2 - notice.length).forEach((p, i) => line(`r${i}`, p));
    line("gap5", []);
    notice.forEach((t, i) => line(`changed${i}`, [{ text: t, tone: "warning" }]));
    if (props.dialog.saving) line("saving", [{ text: "saving…", tone: "muted" }]);
    else
      out.push(
        <Buttons
          key="buttons"
          labels={labels}
          focused={Math.min(focused, labels.length - 1)}
          width={inner}
        />,
      );
    return out;
  };
  return <Dialog title={`Save profile ${name}`} size="large" rows={rows} />;
}
