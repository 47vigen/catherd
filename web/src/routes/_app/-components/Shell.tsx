import { ChartLine, CircleQuestion, Gear, House, ListUl } from "@gravity-ui/icons";
import { cn, Link } from "@heroui/react";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { Brand } from "../../../components/brand/Brand";

export type NavLinkProps = {
  href: string;
  className?: string;
  "aria-current"?: "page";
  children: ReactNode;
};

type NavItem = { href: string; label: string; icon: ComponentType<SVGProps<SVGSVGElement>> };

const GROUPS: readonly { label: string; items: readonly NavItem[] }[] = [
  {
    label: "Watch",
    items: [
      { href: "/", label: "Dashboard", icon: House },
      { href: "/runs", label: "Runs", icon: ListUl },
      { href: "/questions", label: "Questions", icon: CircleQuestion },
    ],
  },
  {
    label: "Configure",
    items: [
      { href: "/models", label: "Models", icon: ChartLine },
      { href: "/setup", label: "Setup", icon: Gear },
    ],
  },
];

function isCurrent(href: string, current: string): boolean {
  if (href === "/") return current === "/";
  return current === href || current.startsWith(`${href}/`);
}

const defaultLink = ({ href, className, children, ...rest }: NavLinkProps) => (
  <Link href={href} className={className} {...rest}>
    {children}
  </Link>
);

function Root({ children }: { children: ReactNode }) {
  return <div className="bg-background flex min-h-dvh">{children}</div>;
}

function NavLink({
  item,
  current,
  renderLink,
}: {
  item: NavItem;
  current: string;
  renderLink: (p: NavLinkProps) => ReactNode;
}) {
  const active = isCurrent(item.href, current);
  const Icon = item.icon;
  return renderLink({
    href: item.href,
    "aria-current": active ? "page" : undefined,
    className: cn(
      "group relative flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-[13px] no-underline transition-colors duration-150",
      active ? "bg-default text-foreground font-medium" : "text-muted hover:bg-surface-secondary hover:text-foreground",
    ),
    children: (
      <>
        <span
          aria-hidden="true"
          className={cn(
            "bg-accent absolute top-1.5 bottom-1.5 -left-3 w-0.5 transition-opacity duration-150",
            active ? "opacity-100" : "opacity-0",
          )}
        />
        <Icon
          aria-hidden="true"
          className={cn("size-4 shrink-0", active ? "text-ink-strong" : "text-muted group-hover:text-foreground")}
        />
        {item.label}
      </>
    ),
  });
}

/** The section links, grouped by what the owner is doing. */
function Nav({
  current,
  renderLink = defaultLink,
  footer,
}: {
  current: string;
  /** Renders each link, so a router can supply its own link component. */
  renderLink?: (p: NavLinkProps) => ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <nav aria-label="Main" className="flex flex-1 flex-col gap-5 px-3 py-4">
        {GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            <span className="label-caps text-muted px-2.5 pb-1">{group.label}</span>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} current={current} renderLink={renderLink} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {footer ? <div className="border-border border-t px-3 py-3">{footer}</div> : null}
    </div>
  );
}

/** The fixed sidebar on wide screens. */
function Sidebar({ search, children }: { search?: ReactNode; children: ReactNode }) {
  return (
    <aside className="border-border bg-surface sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r md:flex">
      <div className="border-border flex h-14 items-center border-b px-5">
        <Brand />
      </div>
      {search ? <div className="px-3 pt-3">{search}</div> : null}
      <div className="min-h-0 flex-1">{children}</div>
    </aside>
  );
}

/** The top bar on narrow screens: the brand and whatever opens the menu. */
function MobileBar({ children }: { children: ReactNode }) {
  return (
    <header className="border-border bg-surface sticky top-0 z-30 flex h-14 items-center justify-between border-b px-4 md:hidden">
      <Brand />
      <div className="flex items-center gap-1">{children}</div>
    </header>
  );
}

function Content({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[1320px] min-w-0 flex-1 flex-col gap-6 px-4 py-6 md:px-8 md:py-8">
      {children}
    </main>
  );
}

export const Shell = Object.assign(Root, { Root, Nav, Sidebar, MobileBar, Content });
