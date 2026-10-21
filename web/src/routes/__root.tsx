import { RouterProvider, Toast } from "@heroui/react";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet, useRouter } from "@tanstack/react-router";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  const router = useRouter();
  // HeroUI links and link buttons navigate through the app router instead of reloading the page.
  return (
    <RouterProvider navigate={(href) => void router.navigate({ href })}>
      <Outlet />
      <Toast.Provider />
    </RouterProvider>
  );
}
