import type { ItemFilters, StatusFilter } from "@/components/item-list";
import type { ItemType } from "@/components/status";

const statuses = {
  open: true,
  in_progress: true,
  done: true,
  canceled: true,
  // triage is no tab of its own: the Open tab's ?status=open matches it
} satisfies Record<StatusFilter, true>;

const isStatus = (value: unknown): value is StatusFilter =>
  typeof value === "string" && Object.hasOwn(statuses, value);

const isType = (value: unknown): value is ItemType =>
  value === "issue" || value === "todo";

/** `?status=` and `?type=` in an item list's URL; absent is All. */
export type ItemSearch = { status?: StatusFilter; type?: ItemType };

/** The status and type filters; anything else in ?status= or ?type= is All. */
export const validateItemSearch = (
  search: Record<string, unknown>,
): ItemSearch => ({
  status: isStatus(search.status) ? search.status : undefined,
  type: isType(search.type) ? search.type : undefined,
});

const nonEmpty = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The feed's `?actor=`, `?product=`, `?project=` and `?type=`; absent is All. */
export type FeedSearch = {
  actor?: string;
  /** Uppercase, as product keys are. */
  product?: string;
  /** A project slug. */
  project?: string;
  type?: ItemType;
};

/** The feed's filters; an empty value or an unknown type is All. */
export const validateFeedSearch = (
  search: Record<string, unknown>,
): FeedSearch => ({
  actor: nonEmpty(search.actor),
  product: nonEmpty(search.product)?.toUpperCase(),
  project: nonEmpty(search.project),
  type: isType(search.type) ? search.type : undefined,
});

/** The filters back to search params, leaving All out of the URL. */
export const itemSearchOf = (filters: ItemFilters): ItemSearch => ({
  ...(filters.status && { status: filters.status }),
  ...(filters.type && { type: filters.type }),
});
