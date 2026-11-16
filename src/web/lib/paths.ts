// Hrefs for the file routes in src/web/routes. Plain strings the route tree doesn't check,
// so renaming a route file means renaming its entry here.
export const paths = {
  feed: "/",
  products: "/products",
  projects: "/projects",
  people: "/people",
  account: "/account",
  signIn: "/sign-in",
  product: (key: string) => `/products/${encodeURIComponent(key)}`,
  project: (slug: string) => `/projects/${encodeURIComponent(slug)}`,
  issue: (key: string) => `/issues/${encodeURIComponent(key)}`,
} as const;
