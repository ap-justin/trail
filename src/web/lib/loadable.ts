/** A read as the screen it's handed to sees it: in flight, failed, or here. */
export type Loadable<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: T };

type QueryLike<T> = { data: T | undefined; isError: boolean };

/** A query's state for a screen: data wins over a failed refetch, so a blip doesn't blank a loaded page. */
export function statusOf(
  query: QueryLike<unknown>,
): Loadable<unknown>["status"] {
  if (query.data !== undefined) return "ready";
  return query.isError ? "error" : "loading";
}

export function loadableOf<T>(query: QueryLike<T>): Loadable<T> {
  if (query.data !== undefined) return { status: "ready", data: query.data };
  return query.isError ? { status: "error" } : { status: "loading" };
}
