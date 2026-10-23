import { cn } from "@heroui/react";
import type { ReactNode } from "react";

/** Every bento tile: one header bar of the same height, the title in the label voice and an aside on the right. */
function Root({
  title,
  aside,
  className,
  bodyClassName,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn("bg-surface border-border flex min-w-0 flex-col overflow-hidden rounded-sm border", className)}
    >
      <header className="border-border flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4">
        <h3 className="label-caps text-muted truncate">{title}</h3>
        {aside}
      </header>
      <div className={cn("flex min-h-0 flex-1 flex-col", bodyClassName)}>{children}</div>
    </section>
  );
}

/** One sheet of figures split by hairlines, the way a spec table reads. */
function Stats({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        "bg-border border-border grid grid-cols-2 gap-px overflow-hidden rounded-sm border md:grid-cols-3 xl:grid-cols-6 max-md:[&>:last-child:nth-child(odd)]:col-span-2",
        className,
      )}
    >
      {children}
    </dl>
  );
}

function Stat({
  label,
  value,
  hint,
  trend,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  trend?: ReactNode;
}) {
  return (
    <div className="bg-surface relative flex min-h-28 flex-col gap-2 p-4">
      <dt className="label-caps text-muted">{label}</dt>
      <dd className="text-[28px] leading-none font-medium tracking-[-0.03em] tabular-nums">{value}</dd>
      {hint || trend ? (
        <dd className="mt-auto flex flex-col gap-1">
          {hint ? <span className="text-muted text-xs">{hint}</span> : null}
          {trend}
        </dd>
      ) : null}
    </div>
  );
}

export const Tile = Object.assign(Root, { Root, Stats, Stat });
