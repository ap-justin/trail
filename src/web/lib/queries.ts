import {
  MutationCache,
  QueryCache,
  QueryClient,
  type QueryClientConfig,
  queryOptions,
} from "@tanstack/react-query";
import { ApiError, api, type FeedFilter } from "@/lib/api";
import type { MeView, WebIssueRowView } from "@/lib/api-types";

export const keys = {
  me: ["me"] as const,
  projects: ["projects"] as const,
  project: (key: string) => ["project", key] as const,
  issues: (key: string, status: WebIssueRowView["status"] | null) =>
    ["project", key, "issues", status] as const,
  statusUpdates: (key: string) => ["project", key, "status-updates"] as const,
  issue: (key: string) => ["issue", key] as const,
  feed: (filter: FeedFilter) => ["feed", filter] as const,
  search: (q: string) => ["search", q] as const,
  people: ["people"] as const,
};

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
    const projects = me.projects
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
