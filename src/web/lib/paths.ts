// Hrefs for the file routes in src/web/routes. Plain strings the route tree doesn't check,
// so renaming a route file means renaming its entry here.
export const paths = {
  feed: "/",
  products: "/products",
  projects: "/projects",
  people: "/people",
  messages: "/messages",
  account: "/account",
  signIn: "/sign-in",
  product: (key: string) => `/products/${encodeURIComponent(key)}`,
  project: (slug: string) => `/projects/${encodeURIComponent(slug)}`,
  /** Bots `a` and `b`'s conversation, by their ids. */
  conversation: (a: string, b: string) =>
    `/messages/${encodeURIComponent(a)}/${encodeURIComponent(b)}`,
  issue: (key: string) => {
    const { key: product, n } = itemParams(key);
    return `/products/${encodeURIComponent(product)}/${encodeURIComponent(n)}`;
  },
} as const;

/** An item key's route params: `TRL-12` is product `TRL`, number `12`. */
export function itemParams(itemKey: string): { key: string; n: string } {
  const dash = itemKey.lastIndexOf("-");
  return { key: itemKey.slice(0, dash), n: itemKey.slice(dash + 1) };
}
