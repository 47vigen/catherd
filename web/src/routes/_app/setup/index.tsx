import { Alert, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";

import type { ProfilePatch } from "../../../client";
import {
  getSetupOptions,
  getSetupQueryKey,
  getVersionOptions,
  previewProfileMutation,
  recheckSetupMutation,
  saveProfileMutation,
} from "../../../client/@tanstack/react-query.gen";
import { DataList } from "../../../components/data-list/DataList";
import { PageHeader, SectionLabel } from "../../../components/page-header/PageHeader";
import { errorMessage } from "../../../lib/api";
import { parseEnum } from "../../../lib/list-search";
import { invalidateOps } from "../../../lib/query";
import { AccessLine } from "./-components/AccessLine";
import { BackendCards } from "./-components/BackendCards";
import { ChangePreview, type Review } from "./-components/ChangePreview";
import { ProfileList } from "./-components/ProfileList";
import { RepoPicker } from "./-components/RepoPicker";
import { RoleRow } from "./-components/RoleRow";
import { IssueList } from "./-components/Section";
import { SettingsSections } from "./-components/SettingsSections";
import { type Found, issuesAt, SECTIONS, type SectionId } from "./-lib/issues";

type SetupSearch = { repo?: string; section?: SectionId };

export const Route = createFileRoute("/_app/setup/")({
  validateSearch: (raw: Record<string, unknown>): SetupSearch => ({
    repo: typeof raw.repo === "string" && raw.repo !== "" ? raw.repo : undefined,
    section: parseEnum(raw.section, SECTIONS),
  }),
  component: SetupPage,
});

/** The profile service answers a save with this path when the document is no longer the one that was previewed. */
const CHANGED_ON_DISK = "profile";
const CHANGED_NOTE = "The profile changed since you opened it. Review the changes again.";

function Block({ id, title, meaning, children }: { id: string; title: string; meaning: string; children: ReactNode }) {
  return (
    <section
      id={`setup-${id}`}
      tabIndex={-1}
      aria-label={title}
      className="flex scroll-mt-4 flex-col gap-3 outline-none"
    >
      <div className="flex flex-col gap-0.5">
        <SectionLabel>{title}</SectionLabel>
        <p className="text-muted text-xs">{meaning}</p>
      </div>
      {children}
    </section>
  );
}

function SetupPage() {
  const { repo, section } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const query = repo === undefined ? undefined : { repo };
  const setup = useQuery(getSetupOptions({ query }));
  const version = useQuery(getVersionOptions());
  const v = setup.data;
  const readOnly = v?.host === "unknown" || version.data?.host === "unknown";
  const [pending, setPending] = useState<{
    patch: ProfilePatch;
    review: Review;
  }>();

  const recheck = useMutation({
    ...recheckSetupMutation(),
    onSuccess: (data) => qc.setQueryData(getSetupQueryKey({ query }), data),
    onError: (e) => toast.danger(errorMessage(e)),
  });
  const preview = useMutation({
    ...previewProfileMutation(),
    onError: (e) => toast.danger(errorMessage(e)),
  });
  const propose = (patch: ProfilePatch, note?: string) =>
    preview.mutate(
      { query, body: { patch } },
      {
        onSuccess: (p) => setPending({ patch, review: { preview: p, refused: [], note } }),
      },
    );
  const save = useMutation({
    ...saveProfileMutation(),
    onSuccess: async (r, vars) => {
      if (r.saved) {
        setPending(undefined);
        toast.success("Saved.");
      } else if (r.errors.some((e) => e.path === CHANGED_ON_DISK)) {
        propose(vars.body.patch, CHANGED_NOTE);
      } else {
        setPending((p) => p && { ...p, review: { ...p.review, refused: r.errors } });
      }
      if (r.saved || r.errors.some((e) => e.path === CHANGED_ON_DISK)) await invalidateOps(qc, "getSetup");
    },
    onError: (e) => toast.danger(errorMessage(e)),
  });

  const loaded = v !== undefined;
  useEffect(() => {
    if (!section || !loaded) return;
    const el = document.getElementById(`setup-${section}`);
    el?.scrollIntoView?.({ block: "start" });
    el?.focus();
  }, [section, loaded]);

  const found: Found[] = v
    ? [
        ...v.issues.errors.map((i) => ({ ...i, error: true })),
        ...v.issues.warnings.map((i) => ({ ...i, error: false })),
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Setup"
        description="The backends catherd can run, the rungs each role climbs, and every setting of the profile. Each change is shown before and after, then saved."
        actions={
          v ? (
            <RepoPicker
              view={v}
              onChange={(next) =>
                void navigate({
                  search: (prev) => ({ ...prev, repo: next }),
                  replace: true,
                })
              }
            />
          ) : null
        }
      />
      <DataList.State
        isLoading={setup.isPending}
        error={setup.error ?? undefined}
        isEmpty={v === undefined}
        emptyText="Nothing to show."
      >
        {v ? (
          <>
            {readOnly ? (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>
                    Setup is read-only until you choose the app that runs catherd (top of the page).
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
            <div className="flex flex-col gap-2">
              <p className="text-[13px]">
                <span className="font-mono">{v.profile.name}</span>{" "}
                <span className="text-muted">{v.repo === null ? "active" : "the profile this repo runs on"}</span>
              </p>
              <IssueList issues={issuesAt(found, "other")} />
              <AccessLine warnings={issuesAt(found, "access")} />
            </div>
            <Block
              id="backends"
              title="Backends"
              meaning="The apps catherd starts workers in, and whether each one is ready."
            >
              <BackendCards
                key={v.probedAt ?? "none"}
                backends={v.backends}
                roles={v.roles}
                probedAt={v.probedAt}
                isChecking={recheck.isPending}
                onRecheck={() => recheck.mutate({ query })}
              />
            </Block>
            <Block
              id="roles"
              title="Roles"
              meaning="Each role climbs its rungs from the first to the last when a rung fails."
            >
              <div className="grid gap-3 2xl:grid-cols-2">
                {v.roles.map((r) => (
                  <RoleRow
                    key={`${r.role}:${r.rungs.map((x) => x.rung).join(",")}`}
                    role={r}
                    timeouts={v.settings.timeouts}
                    issues={issuesAt(found, `role:${r.role}`)}
                    propose={propose}
                    disabled={readOnly}
                  />
                ))}
              </div>
            </Block>
            <Block
              id="settings"
              title="Settings"
              meaning="Everything else the profile holds, grouped by what it controls."
            >
              <SettingsSections view={v} issues={found} propose={propose} disabled={readOnly} />
            </Block>
            <Block
              id="profiles"
              title="Profiles"
              meaning="The profiles you can run on, and which repos are bound to which."
            >
              <ProfileList view={v} disabled={readOnly} />
            </Block>
          </>
        ) : null}
      </DataList.State>
      <ChangePreview
        review={pending?.review}
        isSaving={save.isPending}
        onCancel={() => setPending(undefined)}
        onSave={() => {
          if (pending)
            save.mutate({
              query,
              body: {
                patch: pending.patch,
                expect: pending.review.preview.expect,
              },
            });
        }}
      />
    </div>
  );
}
