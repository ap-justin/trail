// Hrefs for the file routes in src/web/routes. Plain strings the route tree doesn't check,
// so renaming a route file means renaming its entry here.
export const paths = {
  feed: "/",
  projects: "/projects",
  people: "/people",
  account: "/account",
  signIn: "/sign-in",
  project: (key: string) => `/projects/${encodeURIComponent(key)}`,
  issue: (key: string) => `/issues/${encodeURIComponent(key)}`,
} as const;
