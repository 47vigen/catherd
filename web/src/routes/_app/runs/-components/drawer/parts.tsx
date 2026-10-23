import { Alert, Spinner } from "@heroui/react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { DispatchDetail, ErrorBody } from "../../../../../client";
import { errorMessage } from "../../../../../lib/api";

/** The dispatch of the attempt on show; null when the attempt has none (a check, a commit, an event). */
export type DispatchQuery = UseQueryResult<DispatchDetail, ErrorBody> | null;

export const Empty = ({ children }: { children: ReactNode }) => <p className="text-muted text-sm">{children}</p>;

export const Loading = () => (
  <div className="flex justify-center py-6">
    <Spinner size="sm" />
  </div>
);

export function QueryError({ error, title }: { error: unknown; title: string }) {
  return (
    <Alert status="danger" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title}</Alert.Title>
        <Alert.Description>{errorMessage(error)}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

/** Shows the loading and error states of a dispatch read; renders `children` with the detail once it is in. */
export function WithDispatch({
  dispatch,
  none,
  children,
}: {
  dispatch: DispatchQuery;
  none: string;
  children: (d: DispatchDetail) => ReactNode;
}) {
  if (!dispatch) return <Empty>{none}</Empty>;
  if (dispatch.isPending) return <Loading />;
  if (dispatch.isError) return <QueryError error={dispatch.error} title="Could not load this step" />;
  return <>{children(dispatch.data)}</>;
}
