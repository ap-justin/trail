// The routes in the build spec; the routes seat mounts a screen at each.
export const paths = {
  feed: "/",
  projects: "/projects",
  people: "/people",
  account: "/account",
  signIn: "/sign-in",
  project: (key: string) => `/projects/${encodeURIComponent(key)}`,
  issue: (key: string) => `/issues/${encodeURIComponent(key)}`,
} as const;
