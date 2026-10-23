import { Button, Chip, Input, Label, TextField, toast } from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { SetupView } from "../../../../client";
import {
  activateProfileMutation,
  createProfileMutation,
  deleteProfileMutation,
} from "../../../../client/@tanstack/react-query.gen";
import { ConfirmDelete } from "../../../../components/confirm-delete/ConfirmDelete";
import { errorMessage } from "../../../../lib/api";
import { invalidateOps } from "../../../../lib/query";
import { IssueList } from "./Section";

/** The profiles: which is active, which repos run on each, and use, create and delete. */
export function ProfileList({ view, disabled }: { view: SetupView; disabled: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<string>();
  const [refused, setRefused] = useState<{ path: string; message: string; error: boolean }[]>([]);
  const refresh = () => invalidateOps(qc, "getSetup");
  const onError = (e: unknown) => toast.danger(errorMessage(e));

  const activate = useMutation({
    ...activateProfileMutation(),
    onSuccess: async () => {
      toast.success("Saved.");
      await refresh();
    },
    onError,
  });
  const create = useMutation({
    ...createProfileMutation(),
    onSuccess: async (r) => {
      setRefused(r.errors.map((e) => ({ ...e, error: true })));
      if (!r.saved) return;
      setName("");
      toast.success("Saved.");
      await refresh();
    },
    onError,
  });
  const remove = useMutation({
    ...deleteProfileMutation(),
    onSuccess: async () => {
      setDeleting(undefined);
      toast.success("Deleted.");
      await refresh();
    },
    onError: (e) => {
      setDeleting(undefined);
      onError(e);
    },
  });

  const reposOf = (profile: string) =>
    Object.entries(view.profile.bindings)
      .filter(([, p]) => p === profile)
      .map(([repo]) => repo);

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {view.profile.profiles.map((p) => {
          const bound = reposOf(p);
          const isActive = p === view.profile.active;
          const here = view.repo !== null && view.profile.name === p && bound.includes(view.repo);
          const why = isActive ? "It is the active profile." : bound.length > 0 ? "A repo runs on it." : undefined;
          return (
            <li key={p} aria-label={p} className="border-border bg-surface flex flex-col gap-2 rounded-sm border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-medium">{p}</span>
                {isActive ? (
                  <Chip size="sm" color="success" variant="soft">
                    Active
                  </Chip>
                ) : null}
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  {view.repo !== null ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={disabled || here}
                      onPress={() =>
                        activate.mutate({
                          path: { name: p },
                          body: { repo: view.repo },
                        })
                      }
                    >
                      {here ? "In use for this repo" : "Use for this repo"}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="secondary"
                    isDisabled={disabled || isActive}
                    onPress={() =>
                      activate.mutate({
                        path: { name: p },
                        body: { repo: null },
                      })
                    }
                  >
                    Make active everywhere
                  </Button>
                  <Button
                    size="sm"
                    variant="danger-soft"
                    isDisabled={disabled || why !== undefined}
                    onPress={() => setDeleting(p)}
                  >
                    Delete
                  </Button>
                </span>
              </div>
              <p className="text-muted text-xs">
                {bound.length === 0 ? "No repo is bound to it." : `Bound repos: ${bound.join(", ")}`}
                {why ? ` It cannot be deleted. ${why}` : ""}
              </p>
            </li>
          );
        })}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() !== "") create.mutate({ body: { name: name.trim() } });
        }}
      >
        <TextField value={name} onChange={setName} isDisabled={disabled} className="w-56">
          <Label>New profile</Label>
          <Input placeholder="name" />
        </TextField>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          isPending={create.isPending}
          isDisabled={disabled || name.trim() === ""}
        >
          Create from defaults
        </Button>
      </form>
      <IssueList issues={refused} />
      <ConfirmDelete
        title={`Delete profile ${deleting ?? ""}?`}
        body="The profile's file is removed. No repo runs on it."
        isOpen={deleting !== undefined}
        isPending={remove.isPending}
        onCancel={() => setDeleting(undefined)}
        onConfirm={() => deleting && remove.mutate({ path: { name: deleting } })}
      />
    </div>
  );
}
