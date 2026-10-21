import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "../../../components/page-header/PageHeader";

export const Route = createFileRoute("/_app/runs/")({
  component: () => <PageHeader title="Runs" description="Every run catherd drove, newest first." />,
});
