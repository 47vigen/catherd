import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "../../../components/page-header/PageHeader";

export const Route = createFileRoute("/_app/setup/")({
  component: () => (
    <PageHeader title="Setup" description="The backends catherd can run, and the rungs each role climbs." />
  ),
});
