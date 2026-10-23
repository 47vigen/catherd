import { Alert, Button, Disclosure, Skeleton, toast } from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";

import type { ProfilePatch, SetupView } from "../../../client";
import {
  getSetupOptions,
  getSetupQueryKey,
  getVersionOptions,
  previewProfileMutation,
  recheckSetupMutation,
  saveProfileMutation,
} from "../../../client/@tanstack/react-query.gen";
import { DataList } from "../../../components/data-list/DataList";
import { PageHeader } from "../../../components/page-header/PageHeader";
import { Tile } from "../../../components/tile/Tile";
import { errorMessage } from "../../../lib/api";
import { parseEnum } from "../../../lib/list-search";
import { invalidateOps } from "../../../lib/query";
import { AccessLine } from "./-components/AccessLine";
import { BackendCards } from "./-components/BackendCards";
import { ChangePreview, type Review } from "./-components/ChangePreview";
import { ProfileList } from "./-components/ProfileList";
import { RepoPicker } from "./-components/RepoPicker";
import { RoleDrawer } from "./-components/RoleDrawer";
import { RolesOverview } from "./-components/RolesOverview";
import { IssueList } from "./-components/Section";
import { SettingsSections } from "./-components/SettingsSections";
import { type Found, issuesAt, SECTIONS, type SectionId } from "./-lib/issues";

type SetupSearch = { repo?: string; section?: SectionId; role?: string };

export const Route = createFileRoute("/_app/setup/")({
  validateSearch: (raw: Record<string, unknown>): SetupSearch => ({
    repo: typeof raw.repo === "string" && raw.repo !== "" ? raw.repo : undefined,
    section: parseEnum(raw.section, SECTIONS),
    role: typeof raw.role === "string" && raw.role !== "" ? raw.role : undefined,
  }),
  component: SetupPage,
});

/** The profile service answers a save with this path when the document is no longer the one that was previewed. */
const CHANGED_ON_DISK = "profile";
const CHANGED_NOTE = "The profile changed since you opened it. Review the changes again.";
const SETTING: readonly SectionId[] = SECTIONS.filter((s) => s !== "roles" && s !== "profiles");

/** A bento cell that a `?section=` link scrolls to and focuses. */
function Anchor({ id, className, children }: { id: string; className: string; children: ReactNode }) {
  return (
    <div id={`setup-${id}`} tabIndex={-1} className={`flex min-w-0 scroll-mt-4 outline-none ${className}`}>
      {children}
    </div>
  );
}

function Loading() {
  return (
    <output aria-label="Loading" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <Tile
        title="Roles"
        className="lg:col-span-12"
        aside={<span className="text-muted text-xs">Checking the backends…</span>}
      >
        <div className="divide-border divide-y">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-4">
              <Skeleton className="size-6 rounded-sm" />
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-6 w-44" />
              <Skeleton className="h-6 w-36 max-sm:hidden" />
              <Skeleton className="ml-auto h-5 w-9 rounded-full" />
            </div>
          ))}
        </div>
      </Tile>
    </output>
  );
}

const money = (n: number) => `$${n}`;
function budgetWord(b: SetupView["settings"]["budget"]): string {
  const parts = [
    b.usd === undefined ? null : money(b.usd),
    b.minutes === undefined ? null : `${b.minutes} min`,
    b.tokens === undefined ? null : `${b.tokens.toLocaleString("en-US")} tokens`,
  ].filter((x) => x !== null);
  return parts.length === 0 ? "No limit" : parts.join(" · ");
}

/** The settings that shape every run, at a glance while the editors are folded away. */
function SettingsGlance({ s }: { s: SetupView["settings"] }) {
  return (
    <Tile.Stats className="rounded-none border-0">
      <Tile.Stat label="Prefer" value={s.objective === "cost" ? "Cost" : "Speed"} hint="when two models both fit" />
      <Tile.Stat label="Budget" value={budgetWord(s.budget)} hint="per run, then it asks you" />
      <Tile.Stat
        label="Timeouts"
        value={`${s.timeouts.idleMin} / ${s.timeouts.wallMin}`}
        hint="minutes silent / in all"
      />
      <Tile.Stat label="Jev" value={s.jev === "auto" ? "Automatic" : "Off"} hint="picks the model per lane" />
      <Tile.Stat label="Confirm first" value={s.preflightConfirm ? "Yes" : "No"} hint="before any worker starts" />
      <Tile.Stat label="Notify" value={`${s.notify.length} of 3`} hint="moments of a run" />
    </Tile.Stats>
  );
}

function SetupPage() {
  const { repo, section, role: openRole } = Route.useSearch();
  const navigate = Route.useNavigate();
  const qc = useQueryClient();
  const query = repo === undefined ? undefined : { repo };
  // A backend still being checked comes back as "checking"; ask again until every probe has answered.
  const setup = useQuery({
    ...getSetupOptions({ query }),
    refetchInterval: (q) => (q.state.data?.pending ? 2000 : false),
  });
  const version = useQuery(getVersionOptions());
  const v = setup.data;
  const readOnly = v?.host === "unknown" || version.data?.host === "unknown";
  const [pending, setPending] = useState<{ patch: ProfilePatch; review: Review }>();
  const [settingsOpen, setSettingsOpen] = useState(section !== undefined && SETTING.includes(section));

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
      { onSuccess: (p) => setPending({ patch, review: { preview: p, refused: [], note } }) },
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
  const setRole = (role: string | undefined) => void navigate({ search: (prev) => ({ ...prev, role }), replace: true });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Setup"
        description="Each role is a job in a run. It tries its first model; if that one fails or runs out, it moves to the next."
        actions={
          v ? (
            <RepoPicker
              view={v}
              onChange={(next) => void navigate({ search: (prev) => ({ ...prev, repo: next }), replace: true })}
            />
          ) : null
        }
      />
      {setup.isPending ? (
        <Loading />
      ) : (
        <DataList.State
          isLoading={false}
          error={setup.error ?? undefined}
          isEmpty={v === undefined}
          emptyText="Nothing to show."
        >
          {v ? (
            <div className="flex flex-col gap-4">
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
              <IssueList issues={issuesAt(found, "other")} />
              <AccessLine warnings={issuesAt(found, "access")} />
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                <Anchor id="roles" className="lg:col-span-12">
                  <Tile
                    title="Roles"
                    className="flex-1"
                    aside={
                      <span className="text-muted truncate text-xs">
                        Profile <span className="text-foreground font-mono">{v.profile.name}</span>
                        {v.repo === null ? " · global default" : " · this repo"}
                      </span>
                    }
                  >
                    <RolesOverview
                      roles={v.roles}
                      issuesOf={(r) => issuesAt(found, `role:${r}`)}
                      propose={propose}
                      disabled={readOnly}
                      onOpen={setRole}
                    />
                  </Tile>
                </Anchor>
                <BackendCards
                  key={v.probedAt ?? "none"}
                  className="lg:col-span-8"
                  backends={v.backends}
                  probedAt={v.probedAt}
                  isChecking={recheck.isPending}
                  onRecheck={() => recheck.mutate({ query })}
                />
                <Anchor id="profiles" className="lg:col-span-4">
                  <Tile title="Profiles" className="flex-1">
                    <ProfileList view={v} disabled={readOnly} />
                  </Tile>
                </Anchor>
                <Disclosure
                  isExpanded={settingsOpen}
                  onExpandedChange={setSettingsOpen}
                  className="flex min-w-0 lg:col-span-12"
                >
                  <Tile
                    title="Settings for every run"
                    className="flex-1"
                    aside={
                      <Button slot="trigger" size="sm" variant="ghost">
                        {settingsOpen ? "Hide" : "Change settings"}
                        <Disclosure.Indicator />
                      </Button>
                    }
                  >
                    {settingsOpen ? null : <SettingsGlance s={v.settings} />}
                    <Disclosure.Content>
                      <Disclosure.Body className="p-0">
                        <SettingsSections view={v} issues={found} propose={propose} disabled={readOnly} />
                      </Disclosure.Body>
                    </Disclosure.Content>
                  </Tile>
                </Disclosure>
              </div>
              <RoleDrawer
                role={v.roles.find((r) => r.role === openRole)}
                timeouts={v.settings.timeouts}
                issues={openRole ? issuesAt(found, `role:${openRole}`) : []}
                propose={propose}
                disabled={readOnly}
                onClose={() => setRole(undefined)}
              />
            </div>
          ) : null}
        </DataList.State>
      )}
      <ChangePreview
        review={pending?.review}
        isSaving={save.isPending}
        onCancel={() => setPending(undefined)}
        onSave={() => {
          if (pending) save.mutate({ query, body: { patch: pending.patch, expect: pending.review.preview.expect } });
        }}
      />
    </div>
  );
}
