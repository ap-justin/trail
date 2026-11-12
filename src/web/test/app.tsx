import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type { EntryView, FeedView, MeView } from "@/lib/api-types";
import { createQueryClient } from "@/lib/queries";
import { createAppRouter } from "@/router";
import { allProjects, kai, maya, trail } from "@/test/fixtures";
import { server } from "@/test/server";

/** The whole app at `path`, on a fresh cache that never retries. */
export function renderApp(path: string) {
  const queryClient = createQueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient,
  });
  render(<RouterProvider router={router} />);
  return { router, queryClient };
}

export const ownerName = "Justin Salas";

export function meView(state: MeView["state"]): MeView {
  switch (state) {
    case "anonymous":
      return { state, login: null, actor: null, projects: [], ownerName };
    case "not_invited":
      return { state, login: "stranger", actor: null, projects: [], ownerName };
    default:
      return {
        state,
        login: "mayachen",
        actor: maya,
        projects: allProjects,
        ownerName,
      };
  }
}

/** Answers `/me` with `state`; `server.use` it again to change who is signed in. */
export function signedInAs(state: MeView["state"]) {
  server.use(http.get("/api/web/me", () => HttpResponse.json(meView(state))));
}

export const notFound = () =>
  HttpResponse.json(
    { error: { code: "not_found", message: "Not found" } },
    { status: 404 },
  );

export function feedPage(items: EntryView[]): FeedView {
  return {
    items,
    nextCursor: null,
    filters: { actors: [kai], projects: [trail] },
  };
}

/** Answers /feed with `items`, recording each request's query. */
export function serveFeed(items: EntryView[] = []) {
  const asked: URLSearchParams[] = [];
  server.use(
    http.get("/api/web/feed", ({ request }) => {
      asked.push(new URL(request.url).searchParams);
      return HttpResponse.json(feedPage(items));
    }),
  );
  return asked;
}
