import { type NotesOrder, notesShownText } from "@/components/notes";
import type { WebItemCountsView } from "@/lib/api-types";
import type { StatusFilter } from "@/lib/item-status";

/**
 * Says a list stopped at its page cap (`ITEM_PAGES_MAX` in lib/queries.ts), so a header
 * count above the rows isn't read as wrong. Renders nothing when every row was read.
 */
export function RowsMissing({
  list,
  shown,
  notes,
}: {
  list:
    | { nextCursor: string | null; counts: Pick<WebItemCountsView, "notes"> }
    | undefined;
  shown: number;
  /** Set when the list is of notes: the status filter it counts under and its order. */
  notes?: { status: StatusFilter | null; order: NotesOrder };
}) {
  if (!list || list.nextCursor === null) return null;
  return (
    <p className="px-4 py-3 text-xs text-muted-foreground lg:px-2">
      {notes
        ? notesShownText(
            shown,
            noteTotal(list.counts.notes, notes.status),
            notes.order,
          )
        : `Only the first ${shown.toLocaleString("en-US")} items are shown.`}
    </p>
  );
}

function noteTotal(
  counts: WebItemCountsView["notes"],
  status: StatusFilter | null,
) {
  if (status === "current") return counts.current;
  if (status === "archived") return counts.archived;
  return counts.current + counts.archived;
}
