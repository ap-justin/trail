import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import type {
  EntryView,
  FeedView,
  MeView,
  WebItemRowView,
} from "@/lib/api-types";
import { createQueryClient } from "@/lib/queries";
import { createAppRouter } from "@/router";
import { allProducts, alpha, itemList, maya, trail } from "@/test/fixtures";
import { server } from "@/test/server";

/** The whole app at `path`, on a fresh cache that never retries unless the test brings its own. */
export function renderApp(
  path: string,
  queryClient = createQueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient,
  });
  render(<RouterProvider router={router} />);
  return { router, queryClient };
}

export const ownerName = "Jordan Smith";

export function meView(state: MeView["state"]): MeView {
  switch (state) {
    case "anonymous":
      return {
        state,
        login: null,
        email: null,
        actor: null,
        products: [],
        ownerName,
        emailSignIn: true,
      };
    case "not_invited":
      return {
        state,
        login: "stranger",
        email: null,
        actor: null,
        products: [],
        ownerName,
        emailSignIn: true,
      };
    default:
      return {
        state,
        login: "mayachen",
        email: null,
        actor: maya,
        products: allProducts,
        ownerName,
        emailSignIn: true,
      };
  }
}

/**
 * Answers `/me` with `state`, and Working now's reads on the feed with nothing in progress;
 * `server.use` it again to change who is signed in.
 */
export function signedInAs(state: MeView["state"]) {
  serveInProgress();
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
    filters: { actors: [alpha], products: [trail], projects: [] },
  };
}

/**
 * Answers the feed's Working now reads, each product's in-progress items of every type,
 * with `byProduct[key]`, or none for a product it doesn't name. Other item reads fall
 * through to the handlers behind it.
 */
export function serveInProgress(
  byProduct: Record<string, WebItemRowView[]> = {},
) {
  server.use(
    http.get("/api/web/products/:key/items", ({ params, request }) => {
      const search = new URL(request.url).searchParams;
      if (search.get("status") !== "in_progress" || search.has("type")) return;
      return HttpResponse.json(itemList(byProduct[String(params.key)] ?? []));
    }),
  );
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
