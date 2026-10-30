import { Alert, cn, Spinner } from "@heroui/react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { DispatchDetail, ErrorBody } from "../../../../../client";
import { errorMessage } from "../../../../../lib/api";

/** The dispatch of the attempt on show; null when the attempt has none (a check, a commit, an event). */
export type DispatchQuery = UseQueryResult<DispatchDetail, ErrorBody> | null;

const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
export const clock = (iso: string | null | undefined) =>
  iso && !Number.isNaN(Date.parse(iso)) ? time.format(new Date(iso)) : null;

/** A quiet placeholder in a hairline frame, so an empty tab still reads as a place. */
export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="border-border text-muted rounded-sm border border-dashed px-4 py-8 text-center text-sm">{children}</p>
);

export const Loading = ({ label = "Loading" }: { label?: string }) => (
  <div className="text-muted flex items-center justify-center gap-2 py-8 text-sm">
    <Spinner size="sm" />
    {label}…
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

/** A labelled block of a tab: the label-caps title, an optional count or aside, then the content. */
export function Section({
  title,
  label,
  aside,
  className,
  children,
}: {
  title: ReactNode;
  /** the region's accessible name, when the title is not plain text */
  label?: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label ?? (typeof title === "string" ? title : undefined)}
      className={cn("flex flex-col gap-2", className)}
    >
      <div className="flex min-h-5 items-center justify-between gap-3">
        <h3 className="label-caps text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Label beside value, one hairline row each: the drawer's spec sheet. */
export type Fact = { k: string; v: ReactNode };

export function Facts({ rows, label }: { rows: Fact[]; label?: string }) {
  if (rows.length === 0) return null;
  return (
    <dl aria-label={label} className="border-border divide-separator divide-y rounded-sm border">
      {rows.map(({ k, v }) => (
        <div key={k} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 px-3 py-2 text-[13px] leading-5">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
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
