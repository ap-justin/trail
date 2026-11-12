import type { QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { ErrorPage } from "@/app/error-page";
import { createQueryClient } from "@/lib/queries";
import { routeTree } from "./routeTree.gen";

// A factory, not a singleton: tests pass a memory history and their own cache and get a fresh router each time.
export function createAppRouter({
  history,
  queryClient = createQueryClient(),
}: {
  history?: RouterHistory;
  queryClient?: QueryClient;
} = {}) {
  return createRouter({
    routeTree,
    history,
    context: { queryClient },
    // Query owns freshness; the router's own preload cache would serve data Query has already invalidated
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: ErrorPage,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
