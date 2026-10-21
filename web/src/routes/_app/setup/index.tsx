import { Alert } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { getSetupOptions } from "../../../client/@tanstack/react-query.gen";
import { DataList } from "../../../components/data-list/DataList";
import { PageHeader, SectionLabel } from "../../../components/page-header/PageHeader";
import { ChecksTable } from "./-components/ChecksTable";
import { RoleLadder } from "./-components/RoleLadder";
import { RungPicker } from "./-components/RungPicker";

export const Route = createFileRoute("/_app/setup/")({ component: SetupPage });

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  );
}

function SetupPage() {
  const setup = useQuery(getSetupOptions());
  const [editing, setEditing] = useState<string>();
  const v = setup.data;
  const issues = v
    ? [
        ...v.issues.errors.map((i) => ({ ...i, error: true })),
        ...v.issues.warnings.map((i) => ({ ...i, error: false })),
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Setup"
        description="The backends catherd can run, and the rungs each role climbs, from the Slopalytics index. Other profile settings: catherd profile set."
      />
      <DataList.State
        isLoading={setup.isPending}
        error={setup.error ?? undefined}
        isEmpty={v === undefined}
        emptyText="Nothing to show."
      >
        {v ? (
          <>
            <Block title="Catalog and backends">
              <ChecksTable checks={[v.catalog, ...v.backends]} />
            </Block>
            <Block title="Profile">
              <p className="text-[13px]">
                <span className="font-mono">{v.profile.name}</span>{" "}
                <span className="text-muted">{v.repo === null ? "active" : "the profile this repo runs on"}</span>
              </p>
              {issues.map((i, n) => (
                <Alert key={n} status={i.error ? "danger" : "warning"}>
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>
                      {i.path}: {i.message}
                      {i.fix ? ` (${i.fix})` : ""}
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              ))}
            </Block>
            <Block title="Roles">
              <div className="grid gap-3 md:grid-cols-2">
                {v.roles.map((r) => (
                  <RoleLadder key={r.role} role={r} onEdit={() => setEditing(r.role)} />
                ))}
              </div>
            </Block>
            <RungPicker role={v.roles.find((r) => r.role === editing)} onClose={() => setEditing(undefined)} />
          </>
        ) : null}
      </DataList.State>
    </div>
  );
}
