import type { ReactNode } from "react";

/** The top of every page: what it is, one line on what it is for, and the page's own actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
  before,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A back link or breadcrumb above the title. */
  before?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3">
      {before}
      <div className="flex items-start justify-between gap-x-6 gap-y-3 max-sm:flex-col">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h1 className="truncate text-2xl leading-8 font-medium tracking-[-0.025em]">{title}</h1>
          {description ? <p className="text-muted max-w-2xl text-sm">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

/** A label for a block inside a page, in the mono label voice, with an optional aside on the right. */
export function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="label-caps text-muted">{children}</h2>
      {aside}
    </div>
  );
}
