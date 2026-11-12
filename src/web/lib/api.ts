import type {
  EntryView,
  FeedView,
  MeView,
  PeopleView,
  PersonView,
  SearchView,
  WebIssueListView,
  WebIssueRowView,
  WebIssueView,
  WebProjectListView,
  WebProjectView,
  WebStatusUpdatePageView,
} from "@/lib/api-types";

/** A non-2xx answer from trail, carrying the server's own message; or no answer at all (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const offline = () =>
  new ApiError(
    0,
    "network",
    "Couldn't reach trail. Check your connection, then try again.",
  );

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body
        ? { "content-type": "application/json", ...init.headers }
        : init?.headers,
    });
  } catch {
    throw offline();
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } })
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? "http_error",
      error?.message ?? `trail answered ${response.status}.`,
    );
  }
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

const query = (params: Record<string, string | number | null | undefined>) => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) search.set(name, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
};

const web = (path: string) => `/api/web${path}`;
const seg = encodeURIComponent;

export type FeedFilter = { actor: string | null; project: string | null };

/** The server's page-size ceiling (`pageQuerySchema` in src/shared/schemas.ts). */
export const MAX_PAGE = 200;

export const api = {
  me: () => request<MeView>(web("/me")),
  projects: () => request<WebProjectListView>(web("/projects")),
  project: (key: string) =>
    request<WebProjectView>(web(`/projects/${seg(key)}`)),
  issues: (key: string, status: WebIssueRowView["status"] | null) =>
    request<WebIssueListView>(
      web(`/projects/${seg(key)}/issues${query({ status, limit: MAX_PAGE })}`),
    ),
  statusUpdates: (key: string) =>
    request<WebStatusUpdatePageView>(
      web(`/projects/${seg(key)}/status-updates${query({ limit: MAX_PAGE })}`),
    ),
  issue: (key: string) => request<WebIssueView>(web(`/issues/${seg(key)}`)),
  feed: (filter: FeedFilter) =>
    request<FeedView>(web(`/feed${query({ ...filter, limit: MAX_PAGE })}`)),
  search: (q: string) => request<SearchView>(web(`/search${query({ q })}`)),
  createIssue: (issue: {
    projectKey: string;
    title: string;
    description: string;
  }) => request<WebIssueView>(web("/issues"), json("POST", issue)),
  comment: (issueKey: string, body: string) =>
    request<EntryView>(
      web(`/issues/${seg(issueKey)}/comments`),
      json("POST", { body }),
    ),
  people: () => request<PeopleView>(web("/people")),
  invite: (invite: { username: string; projectKeys: string[] }) =>
    request<PersonView>(web("/people"), json("POST", invite)),
  setProjects: (username: string, projectKeys: string[]) =>
    request<PersonView>(
      web(`/people/${seg(username)}`),
      json("PUT", { projectKeys }),
    ),
  remove: (username: string) =>
    request<void>(web(`/people/${seg(username)}`), { method: "DELETE" }),
  /**
   * better-auth answers with the GitHub URL to send the browser to. GitHub returns to
   * `callbackURL`, or on a failure to `/sign-in?error=<code>`.
   */
  signIn: (callbackURL: string) =>
    request<{ url: string }>(
      "/api/auth/sign-in/social",
      json("POST", {
        provider: "github",
        callbackURL,
        errorCallbackURL: "/sign-in",
      }),
    ),
  signOut: () => request<unknown>("/api/auth/sign-out", json("POST", {})),
  eventsUrl: (filter: FeedFilter) => web(`/events${query(filter)}`),
};

/** trail answers a missing and a hidden project or issue alike, with 404. */
export const isNotFound = (error: Error | null) =>
  error instanceof ApiError && error.status === 404;
