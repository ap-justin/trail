import {
  MutationCache,
  QueryCache,
  QueryClient,
  type QueryClientConfig,
  queryOptions,
} from "@tanstack/react-query";
import {
  ApiError,
  api,
  type FeedFilter,
  type ItemQuery,
  type ProjectItemQuery,
} from "@/lib/api";
import type {
  MeView,
  WebItemListView,
  WebProjectItemsView,
  WebProjectView,
} from "@/lib/api-types";

export const keys = {
  me: ["me"] as const,
  products: ["products"] as const,
  product: (key: string) => ["product", key] as const,
  productItems: (key: string, { type, status }: ItemQuery) =>
    ["product", key, "items", type, status] as const,
  productStatusUpdates: (key: string) =>
    ["product", key, "status-updates"] as const,
  projects: ["projects"] as const,
  project: (slug: string) => ["project", slug] as const,
  projectItems: (slug: string, { product, type, status }: ProjectItemQuery) =>
    ["project", slug, "items", product, type, status] as const,
  projectStatusUpdates: (slug: string) =>
    ["project", slug, "status-updates"] as const,
  issue: (key: string) => ["issue", key] as const,
  feed: (filter: FeedFilter) => ["feed", filter] as const,
  search: (q: string) => ["search", q] as const,
  people: ["people"] as const,
};

/** Reads pages in order until one has no `nextCursor` or `max` pages are in; never empty. */
async function readPages<Page extends { nextCursor: string | null }>(
  read: (cursor: string | null) => Promise<Page>,
  max: number,
): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const page = await read(cursor);
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor !== null && pages.length < max);
  return pages;
}

/** Pages of projects the list reads before it stops: the list screen has no Load more. */
export const PROJECT_PAGES_MAX = 10;

/** Every project the viewer can see, newest first, up to `PROJECT_PAGES_MAX` pages. */
export const projectsQuery = queryOptions({
  queryKey: keys.projects,
  queryFn: async (): Promise<WebProjectView[]> =>
    (await readPages(api.projects, PROJECT_PAGES_MAX)).flatMap((p) => p.items),
});

/**
 * The last list read for the same `scope` (the query key up to its type and status) while
 * the next filter's loads, so tabs and counts stay put. The views filter rows by the active
 * filters, and counts don't follow type or status, so neither is wrong in the meantime.
 */
const keepWithin =
  (scope: readonly unknown[]) =>
  <T>(
    previous: T | undefined,
    previousQuery?: { queryKey: readonly unknown[] },
  ) =>
    previousQuery &&
    scope.every((part, i) => previousQuery.queryKey[i] === part)
      ? previous
      : undefined;

/** Pages of a product's or project's items the page reads before it stops: neither has Load more. */
export const ITEM_PAGES_MAX = 10;

/**
 * A product's items under `filters`, every page up to `ITEM_PAGES_MAX`, as one list. A
 * `nextCursor` left set means the cap cut the list short.
 */
export const productItemsQuery = (key: string, filters: ItemQuery) =>
  queryOptions({
    queryKey: keys.productItems(key, filters),
    queryFn: async (): Promise<WebItemListView> =>
      (
        await readPages(
          (cursor) => api.productItems(key, filters, cursor),
          ITEM_PAGES_MAX,
        )
      ).reduce((read, page) => ({
        ...page,
        items: [...read.items, ...page.items],
      })),
    placeholderData: keepWithin(["product", key, "items"]),
  });

type ItemGroup = WebProjectItemsView["groups"][number];

/** The next page continues the last group, so a product split across two pages is one group again. */
function joinGroups(read: ItemGroup[], page: ItemGroup[]): ItemGroup[] {
  const last = read.at(-1);
  const [first, ...rest] = page;
  if (!last || !first || last.product.key !== first.product.key) {
    return [...read, ...page];
  }
  return [
    ...read.slice(0, -1),
    { ...first, items: [...last.items, ...first.items] },
    ...rest,
  ];
}

/**
 * A project's item groups under `filters`, every page up to `ITEM_PAGES_MAX`, as one set of
 * groups. A `nextCursor` left set means the cap cut the groups short.
 */
export const projectItemsQuery = (slug: string, filters: ProjectItemQuery) =>
  queryOptions({
    queryKey: keys.projectItems(slug, filters),
    queryFn: async (): Promise<WebProjectItemsView> =>
      (
        await readPages(
          (cursor) => api.projectItems(slug, filters, cursor),
          ITEM_PAGES_MAX,
        )
      ).reduce((read, page) => ({
        ...page,
        groups: joinGroups(read.groups, page.groups),
      })),
    // counts follow the product filter, so another product's list would miscount
    placeholderData: keepWithin(["project", slug, "items", filters.product]),
  });

export const meQuery = queryOptions({
  queryKey: keys.me,
  queryFn: api.me,
  // the session can end in another tab or by the owner removing this person
  refetchOnWindowFocus: "always",
});

export const isMember = (me: MeView) =>
  me.state === "member" || me.state === "owner";

/** A 4xx won't change on a retry: a hidden project stays hidden, a lapsed session stays lapsed. */
const retry = (failures: number, error: Error) =>
  failures < 2 &&
  !(error instanceof ApiError && error.status >= 400 && error.status < 500);

/**
 * The app's cache. A 401 or 403 from any call means the session ended or the person was
 * removed, so `/me` is read again and the signed-in layout follows what it says.
 */
export function createQueryClient(config: QueryClientConfig = {}) {
  const recheckSession = (error: Error) => {
    if (
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403)
    ) {
      void client.invalidateQueries({ queryKey: keys.me });
    }
  };
  // the feed never refetches on focus, so when `/me` grants or takes away a project, this
  // re-reads the feed: its rows and its filter options both come from `/feed`
  let projectsSeen: string | undefined;
  const followProjects = () => {
    const me = client.getQueryData(meQuery.queryKey);
    if (!me || !isMember(me)) return;
    const projects = me.products
      .map((p) => p.key)
      .toSorted()
      .join("\u0000");
    if (projectsSeen !== undefined && projects !== projectsSeen) {
      void client.invalidateQueries({ queryKey: ["feed"] });
    }
    projectsSeen = projects;
  };
  const client = new QueryClient({
    ...config,
    queryCache: new QueryCache({
      onError: recheckSession,
      onSuccess: (_data, query) => {
        if (query.queryKey[0] === keys.me[0]) followProjects();
      },
    }),
    mutationCache: new MutationCache({ onError: recheckSession }),
    defaultOptions: {
      ...config.defaultOptions,
      queries: { retry, ...config.defaultOptions?.queries },
    },
  });
  return client;
}
