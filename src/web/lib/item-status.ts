import type { IssueStatus, ItemType } from "@/components/status";

/** A status tab: triage has none of its own, Open covers it. */
export type StatusFilter = Exclude<IssueStatus, "triage">;

const workStatuses: readonly StatusFilter[] = [
  "open",
  "in_progress",
  "done",
  "canceled",
];
const noteStatuses: readonly StatusFilter[] = ["current", "archived"];

/** The status tabs a type has: a note's two states, or the work statuses for the rest and All. */
export const statusesOf = (type: ItemType | null): readonly StatusFilter[] =>
  type === "note" ? noteStatuses : workStatuses;

/** A tab value back to its filter: All and anything unknown are null. */
export function statusFilterOf(value: string): StatusFilter | null {
  return (
    [...workStatuses, ...noteStatuses].find((status) => status === value) ??
    null
  );
}
