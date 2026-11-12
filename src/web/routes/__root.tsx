import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { RouterLink } from "@/app/router-link";
import { LinkProvider } from "@/components/app-link";
import { ThemeProvider } from "@/components/theme-provider";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    component: Root,
  },
);

function Root() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <LinkProvider component={RouterLink}>
          <Outlet />
        </LinkProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
