import { ArrowRightFromSquare, Bars, Display, Moon, Sun } from "@gravity-ui/icons";
import { Button, Drawer, Dropdown, Label, Tooltip, useTheme } from "@heroui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";

import { getSessionOptions, getVersionOptions, logoutMutation } from "../client/@tanstack/react-query.gen";
import { Brand } from "../components/brand/Brand";
import { CommandMenu } from "./_app/-components/CommandMenu";
import { Shell } from "./_app/-components/Shell";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(getSessionOptions());
    } catch {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  component: AppLayout,
});

const THEMES = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Display },
] as const;

function ThemeMenu() {
  const { theme, setTheme } = useTheme("system");
  const ThemeIcon = THEMES.find((t) => t.id === theme)?.icon ?? Display;
  return (
    <Dropdown>
      <Button isIconOnly size="sm" variant="ghost" aria-label="Theme">
        <ThemeIcon aria-hidden="true" />
      </Button>
      <Dropdown.Popover placement="top end">
        <Dropdown.Menu
          aria-label="Theme"
          selectionMode="single"
          selectedKeys={[theme]}
          onAction={(key) => setTheme(String(key))}
        >
          {THEMES.map(({ id, label, icon: Icon }) => (
            <Dropdown.Item key={id} id={id} textValue={label}>
              <Icon aria-hidden="true" className="size-4" />
              <Label>{label}</Label>
              <Dropdown.ItemIndicator />
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

function AppLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const queryClient = Route.useRouteContext({ select: (c) => c.queryClient });
  const version = useQuery(getVersionOptions());
  // The menu remembers the page it was opened on, so following a link closes it without an effect.
  const [menuOpenOn, setMenuOpenOn] = useState<string>();
  const logout = useMutation({
    ...logoutMutation(),
    onSettled: async () => {
      queryClient.clear();
      await navigate({ to: "/login", search: { redirect: undefined } });
    },
  });

  const footer = (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted truncate pl-2.5 font-mono text-[11px]">
        {version.data?.catherd ? version.data.catherd.replace(/^(\d)/, "v$1") : ""}
      </span>
      <span className="flex items-center gap-0.5">
        <ThemeMenu />
        <Tooltip>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Sign out"
            isPending={logout.isPending}
            onPress={() => logout.mutate({})}
          >
            <ArrowRightFromSquare aria-hidden="true" />
          </Button>
          <Tooltip.Content>Sign out</Tooltip.Content>
        </Tooltip>
      </span>
    </div>
  );

  return (
    <CommandMenu>
      <Shell.Root>
        <Shell.Sidebar search={<CommandMenu.Trigger />}>
          <Shell.Nav current={pathname} footer={footer} />
        </Shell.Sidebar>
        <div className="flex min-w-0 flex-1 flex-col">
          <Shell.MobileBar>
            <CommandMenu.Trigger />
            <Button isIconOnly variant="ghost" aria-label="Menu" onPress={() => setMenuOpenOn(pathname)}>
              <Bars aria-hidden="true" />
            </Button>
          </Shell.MobileBar>
          <Shell.Content>
            <div key={pathname} className="page-enter flex flex-col gap-6">
              <Outlet />
            </div>
          </Shell.Content>
        </div>
        <Drawer.Backdrop
          isOpen={menuOpenOn === pathname}
          onOpenChange={(open) => setMenuOpenOn(open ? pathname : undefined)}
        >
          <Drawer.Content placement="left" className="w-72 max-w-[85vw]">
            <Drawer.Dialog aria-label="Menu" className="bg-surface p-0">
              <div className="border-border flex h-14 items-center border-b px-5">
                <Brand />
              </div>
              <Shell.Nav current={pathname} footer={footer} />
            </Drawer.Dialog>
          </Drawer.Content>
        </Drawer.Backdrop>
      </Shell.Root>
    </CommandMenu>
  );
}
