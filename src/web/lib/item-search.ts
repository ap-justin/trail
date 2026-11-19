import type { ItemFilters, StatusFilter } from "@/components/item-list";
import type { ItemType } from "@/components/status";

const statuses = {
  open: true,
  in_progress: true,
  done: true,
  canceled: true,
  current: true,
  archived: true,
  // triage is no tab of its own: the Open tab's ?status=open matches it
} satisfies Record<StatusFilter, true>;

const isStatus = (value: unknown): value is StatusFilter =>
  typeof value === "string" && Object.hasOwn(statuses, value);

const isType = (value: unknown): value is ItemType =>
  value === "issue" || value === "todo" || value === "note";

/** `?status=` and `?type=` in an item list's URL; absent is All. */
export type ItemSearch = { status?: StatusFilter; type?: ItemType };

/** The status and type filters; anything else in ?status= or ?type= is All. */
export const validateItemSearch = (
  search: Record<string, unknown>,
): ItemSearch => ({
  status: isStatus(search.status) ? search.status : undefined,
  type: isType(search.type) ? search.type : undefined,
});

/**
 * A search value as the text typed in the URL; an empty one is absent. The router's
 * parseSearch reads `2026` and `1E5` as numbers before a validator sees them, so a number
 * comes back as its digits (`1E5` as `100000`: the original spelling is gone by then).
 */
export const searchText = (value: unknown): string | undefined => {
  const text =
    typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  return typeof text === "string" && text !== "" ? text : undefined;
};

/** The feed's `?actor=`, `?product=`, `?project=` and `?type=`; absent is All. */
export type FeedSearch = {
  actor?: string;
  /** Uppercase, as product keys are. */
  product?: string;
  /** A project slug: lowercase, as slugs are. */
  project?: string;
  type?: ItemType;
};

/** The feed's filters; an empty value or an unknown type is All. */
export const validateFeedSearch = (
  search: Record<string, unknown>,
): FeedSearch => ({
  actor: searchText(search.actor),
  product: searchText(search.product)?.toUpperCase(),
  project: searchText(search.project)?.toLowerCase(),
  type: isType(search.type) ? search.type : undefined,
});

/** The filters back to search params, leaving All out of the URL. */
export const itemSearchOf = (filters: ItemFilters): ItemSearch => ({
  ...(filters.status && { status: filters.status }),
  ...(filters.type && { type: filters.type }),
});
