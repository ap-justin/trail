import {
  infiniteQueryOptions,
  MutationCache,
  type Query,
  QueryCache,
  QueryClient,
  type QueryClientConfig,
  queryOptions,
  skipToken,
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
  productNoteCounts: (key: string) => ["product", key, "note-counts"] as const,
  productStatusUpdates: (key: string) =>
    ["product", key, "status-updates"] as const,
  projects: ["projects"] as const,
  project: (slug: string) => ["project", slug] as const,
  projectItems: (slug: string, { product, type, status }: ProjectItemQuery) =>
    ["project", slug, "items", product, type, status] as const,
  projectNoteCounts: (slug: string, product: string | null) =>
    ["project", slug, "note-counts", product] as const,
  projectStatusUpdates: (slug: string) =>
    ["project", slug, "status-updates"] as const,
  issue: (key: string) => ["issue", key] as const,
  feed: (filter: FeedFilter) => ["feed", filter] as const,
  workingNow: ["working-now"] as const,
  search: (q: string) => ["search", q] as const,
  people: ["people"] as const,
  conversations: ["conversations"] as const,
  conversation: (a: string, b: string) => ["conversation", a, b] as const,
};

/**
 * Reads pages in order until one has no `nextCursor` or `max` pages are in; never empty.
 * `onFirstPage` sees the first page as soon as it arrives.
 */
async function readPages<Page extends { nextCursor: string | null }>(
  read: (cursor: string | null) => Promise<Page>,
  max: number,
  onFirstPage?: (page: Page) => void,
): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const page = await read(cursor);
    if (pages.length === 0) onFirstPage?.(page);
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

/** Pages of a product's or project's items the page reads before it stops: neither has Load more. */
export const ITEM_PAGES_MAX = 10;

/**
 * A product's items under `filters`, every page up to `ITEM_PAGES_MAX`, as one list. A
 * `nextCursor` left set means the cap cut the list short.
 */
export const productItemsQuery = (key: string, filters: ItemQuery) =>
  queryOptions({
    queryKey: keys.productItems(key, filters),
    queryFn: async ({ client }): Promise<WebItemListView> =>
      (
        await readPages(
          (cursor) => api.productItems(key, filters, cursor),
          ITEM_PAGES_MAX,
          (page) =>
            client.setQueryData(keys.productNoteCounts(key), page.counts.notes),
        )
      ).reduce((read, page) => ({
        ...page,
        items: [...read.items, ...page.items],
      })),
    // the same product's last list while the next filter's loads, so tabs and counts stay
    // put: the view filters rows by the active filters, and a product's counts don't follow
    // type or status
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === key ? previous : undefined,
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
    queryFn: async ({ client }): Promise<WebProjectItemsView> =>
      (
        await readPages(
          (cursor) => api.projectItems(slug, filters, cursor),
          ITEM_PAGES_MAX,
          (page) =>
            client.setQueryData(
              keys.projectNoteCounts(slug, filters.product),
              page.counts.notes,
            ),
        )
      ).reduce((read, page) => ({
        ...page,
        groups: joinGroups(read.groups, page.groups),
      })),
    // the same project and product's last list while the next type or status loads, for its
    // counts, which follow only the product filter; a group's count follows every filter, so
    // the caller shows none of its groups
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === slug &&
      previousQuery.queryKey[3] === filters.product
        ? previous
        : undefined,
  });

type NoteCounts = WebItemListView["counts"]["notes"];

/**
 * A product's note counts as the first page of any of its lists last read them, so they
 * arrive before a long list's later pages; never fetched on their own.
 */
export const productNoteCountsQuery = (key: string) =>
  queryOptions<NoteCounts>({
    queryKey: keys.productNoteCounts(key),
    queryFn: skipToken,
  });

/** A project's note counts under the product filter, as `productNoteCountsQuery` reads a product's. */
export const projectNoteCountsQuery = (slug: string, product: string | null) =>
  queryOptions<NoteCounts>({
    queryKey: keys.projectNoteCounts(slug, product),
    queryFn: skipToken,
  });

/** Bots at work across the viewer's products, for the feed's Working now strip. */
export const workingNowQuery = queryOptions({
  queryKey: keys.workingNow,
  queryFn: api.workingNow,
  // the feed's stream re-reads it as bot work moves; a mount still reads, since no stream
  // ran while the viewer was off the feed
  refetchOnWindowFocus: false,
});

const nextCursor = (page: { nextCursor: string | null }) => page.nextCursor;

/**
 * How long messages read stay fresh. A refetch of an infinite query re-reads every loaded
 * page one after another, so without this each window focus costs a request per Load more.
 * No maxPages: it would drop the earliest loaded rows from a list that only pages forward.
 */
export const MESSAGES_STALE_MS = 60_000;

/** Every pair of bots that has exchanged messages, newest first, a page at a time. */
export const conversationsQuery = infiniteQueryOptions({
  queryKey: keys.conversations,
  queryFn: ({ pageParam }) => api.conversations(pageParam),
  initialPageParam: null as string | null,
  getNextPageParam: nextCursor,
  staleTime: MESSAGES_STALE_MS,
});

/** Bots `a` and `b`'s messages, oldest first, a page at a time. */
export const conversationQuery = (a: string, b: string) =>
  infiniteQueryOptions({
    queryKey: keys.conversation(a, b),
    queryFn: ({ pageParam }) => api.conversation(a, b, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: nextCursor,
    staleTime: MESSAGES_STALE_MS,
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
  // the order each query's read in flight, or last read, was asked in; a read restarted
  // while in flight keeps its first ask's place
  let asks = 0;
  const askedAt = new WeakMap<object, number>();
  const askedAfter = (query: object, earlier: object) =>
    (askedAt.get(query) ?? 0) > (askedAt.get(earlier) ?? 0);
  // the feed and Working now never refetch on focus, so when `/me` grants or takes away a
  // project, this re-reads both: the feed's rows and filter options come from `/feed`, and
  // no `work` event follows a membership change. A read asked after this `/me` one already
  // follows the access it reports, as the feed's `access` handler asks for them after it
  let projectsSeen: string | undefined;
  const followProjects = (meRead: object) => {
    const me = client.getQueryData(meQuery.queryKey);
    if (!me || !isMember(me)) return;
    const projects = me.products
      .map((p) => p.key)
      .toSorted()
      .join("\u0000");
    if (projectsSeen !== undefined && projects !== projectsSeen) {
      const askedBeforeMe = (query: Query) => !askedAfter(query, meRead);
      void client.invalidateQueries({
        queryKey: ["feed"],
        predicate: askedBeforeMe,
      });
      void client.invalidateQueries({
        queryKey: keys.workingNow,
        predicate: askedBeforeMe,
      });
    }
    projectsSeen = projects;
  };
  const queryCache = new QueryCache({
    onError: recheckSession,
    onSuccess: (_data, query) => {
      if (query.queryKey[0] === keys.me[0]) followProjects(query);
    },
  });
  queryCache.subscribe((event) => {
    if (event.type === "updated" && event.action.type === "fetch") {
      askedAt.set(event.query, ++asks);
    }
  });
  const client = new QueryClient({
    ...config,
    queryCache,
    mutationCache: new MutationCache({ onError: recheckSession }),
    defaultOptions: {
      ...config.defaultOptions,
      queries: { retry, ...config.defaultOptions?.queries },
    },
  });
  return client;
}
