import { Alert, Button, Modal } from "@heroui/react";

import { modelName, parseRung } from "../-lib/rung";
import type { Issue, ProfilePreview } from "../../../../client";
import { ProviderIcon } from "../../../../components/provider-icon/ProviderIcon";

export interface Review {
  preview: ProfilePreview;
  /** the errors of a save the server refused */
  refused: Issue[];
  /** why the review is shown again, such as a profile that changed on disk */
  note?: string;
}

const show = (v: unknown): string =>
  v === null || v === undefined ? "unset" : typeof v === "string" ? v : JSON.stringify(v);

const isRungs = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.includes(":"));

/** A value of the diff; a list of rungs reads as the numbered models it is. */
function Value({ v }: { v: unknown }) {
  if (!isRungs(v)) return <span className="font-mono text-xs break-words">{show(v)}</span>;
  return (
    <ol className="flex flex-col gap-1">
      {v.map((rung, i) => {
        const r = parseRung(rung);
        return (
          <li key={rung} className="flex min-w-0 items-center gap-2 text-[13px]" title={rung}>
            <span className="text-muted w-3 shrink-0 text-right text-xs tabular-nums">{i + 1}</span>
            <ProviderIcon backend={r.backend} size="xs" />
            <span className="truncate">{modelName(r.model)}</span>
            {r.effort ? <span className="text-muted text-[11px]">{r.effort}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function Issues({ status, title, issues }: { status: "danger" | "warning"; title: string; issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <Alert status={status}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        {issues.map((i, n) => (
          <Alert.Description key={n}>
            {i.path}: {i.message}
            {i.fix ? ` (${i.fix})` : ""}
          </Alert.Description>
        ))}
      </Alert.Content>
    </Alert>
  );
}

/** The change as before → after, with the profile's own errors and warnings, before anything is written. */
export function ChangePreview({
  review,
  isSaving,
  onSave,
  onCancel,
}: {
  review: Review | undefined;
  isSaving: boolean;
  onSave(): void;
  onCancel(): void;
}) {
  const p = review?.preview;
  // "Not saved" names only what this change breaks; errors the profile already had are listed apart
  const added = p?.added ?? [];
  const errors = [...added, ...(review?.refused ?? [])];
  const before = (p?.errors ?? []).filter((e) => !added.some((a) => a.path === e.path && a.message === e.message));
  // A warning about another part of the profile is not about this change; it is counted, not listed.
  const touched = (p?.diff ?? []).map((d) => d.path.split(".").slice(0, 2).join("."));
  const near = (i: Issue) =>
    touched.some((t) => i.path === t || i.path.startsWith(`${t}.`) || t.startsWith(`${i.path}.`));
  const warnings = (p?.warnings ?? []).filter(near);
  const elsewhere = (p?.warnings.length ?? 0) - warnings.length;
  return (
    <Modal.Backdrop isOpen={review !== undefined} onOpenChange={(open) => !open && !isSaving && onCancel()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-label="Review changes">
          <Modal.Header>
            <Modal.Heading>Review changes</Modal.Heading>
            <p className="text-muted text-xs">Nothing is written until you press Save.</p>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            {review?.note ? <p className="text-warning text-sm">{review.note}</p> : null}
            {p && p.diff.length === 0 ? <p className="text-muted text-sm">Nothing would change.</p> : null}
            <ul className="flex flex-col gap-2">
              {p?.diff.map((d) => (
                <li key={d.path} className="border-border overflow-hidden rounded-sm border">
                  <p className="bg-surface-secondary text-muted px-3 py-1.5 font-mono text-xs">{d.path}</p>
                  <div className="divide-border grid grid-cols-2 divide-x">
                    <div className="flex min-w-0 flex-col gap-1.5 p-3">
                      <span className="label-caps text-muted">Before</span>
                      <Value v={d.before} />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5 p-3">
                      <span className="label-caps text-accent">After</span>
                      <Value v={d.after} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <Issues status="danger" title="Not saved" issues={errors} />
            <Issues status="warning" title="Already wrong before this change" issues={before} />
            <Issues status="warning" title="Worth a look" issues={warnings} />
            {elsewhere > 0 ? (
              <p className="text-muted text-xs">
                {elsewhere === 1
                  ? "1 more warning is about another part of the profile."
                  : `${elsewhere} more warnings are about other parts of the profile.`}
              </p>
            ) : null}
            {p && p.newSessionNeededFor.length > 0 ? (
              <p className="text-muted text-xs">A new session is needed for: {p.newSessionNeededFor.join(", ")}.</p>
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Button size="sm" variant="secondary" isDisabled={isSaving} onPress={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              isPending={isSaving}
              isDisabled={!p || p.diff.length === 0 || !p.wouldSave}
              onPress={onSave}
            >
              Save
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
