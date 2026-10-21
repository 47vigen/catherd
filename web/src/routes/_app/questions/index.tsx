import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "../../../components/page-header/PageHeader";

export const Route = createFileRoute("/_app/questions/")({
  component: () => <PageHeader title="Questions" description="Units of a run that wait for your answer." />,
});
