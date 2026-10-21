import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({
  beforeLoad: () => {
    throw redirect({ to: "/runs", search: { page: 1, pageSize: 25, q: "" } });
  },
});
