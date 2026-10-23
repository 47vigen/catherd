import { Alert, Button, Modal } from "@heroui/react";

import type { Issue, ProfilePreview } from "../../../../client";

export interface Review {
  preview: ProfilePreview;
  /** the errors of a save the server refused */
  refused: Issue[];
  /** why the review is shown again, such as a profile that changed on disk */
  note?: string;
}

const show = (v: unknown): string =>
  v === null || v === undefined ? "unset" : typeof v === "string" ? v : JSON.stringify(v);

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
  const errors = [...(p?.errors ?? []), ...(review?.refused ?? [])];
  return (
    <Modal.Backdrop isOpen={review !== undefined} onOpenChange={(open) => !open && !isSaving && onCancel()}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog aria-label="Review changes">
          <Modal.Header>
            <Modal.Heading>Review changes</Modal.Heading>
            <p className="text-muted text-xs">This is what saving writes to the profile.</p>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            {review?.note ? <p className="text-warning text-sm">{review.note}</p> : null}
            {p && p.diff.length === 0 ? <p className="text-muted text-sm">Nothing would change.</p> : null}
            <ul className="flex flex-col gap-1.5">
              {p?.diff.map((d) => (
                <li key={d.path} className="bg-surface-secondary rounded-sm px-3 py-1.5 font-mono text-xs break-words">
                  <span className="text-muted">{d.path}: </span>
                  {show(d.before)} → <span className="text-foreground font-medium">{show(d.after)}</span>
                </li>
              ))}
            </ul>
            <Issues status="danger" title="Not saved" issues={errors} />
            <Issues status="warning" title="Worth a look" issues={p?.warnings ?? []} />
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
              isDisabled={!p || p.diff.length === 0 || p.errors.length > 0}
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
