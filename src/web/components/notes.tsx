import { useId, useRef } from "react";
import { RowLink } from "@/components/app-link";
import { ErrorState, LoadingRegion, SkeletonBlock } from "@/components/states";
import { Age, AsideHeading } from "@/components/status-updates";
import { KeyText } from "@/components/text";
import { Button } from "@/components/ui/button";
import type { WebItemCountsView, WebItemRowView } from "@/lib/api-types";
import type { Loadable } from "@/lib/loadable";
import { paths } from "@/lib/paths";
import { cn } from "@/lib/utils";

/** A read of the current notes: its rows and what the same read counted. */
export type NotesRead = {
  items: WebItemRowView[];
  /** Set when the page cap (`ITEM_PAGES_MAX` in lib/queries.ts) cut the read short. */
  nextCursor: string | null;
  /** The current notes, as the same read counted them. */
  total: number;
};

/** How a notes list is ordered: newest first, or by product and then newest first. */
export type NotesOrder = "newest" | "first";

/** `Showing the newest 2,000 of 2,345 notes`: a notes list the page cap cut short. */
export const notesShownText = (
  shown: number,
  total: number,
  order: NotesOrder,
) =>
  `Showing the ${order} ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${total === 1 ? "note" : "notes"}`;

export type NotesSectionProps = {
  /** The current notes, in the list's order. */
  notes: Loadable<NotesRead>;
  /** Null until the page first counts its items; nothing renders until then. */
  counts: WebItemCountsView["notes"] | null;
  /** The notes read's order, which the cap line names. */
  order: NotesOrder;
  /** Lists the page's archived notes in its own item list. */
  onShowArchived: () => void;
  onRetry: () => void;
  now: Date;
  className?: string;
};

/**
 * A product's or project's current notes under the work list: key, title and age a row,
 * a line saying so when the page cap cut the read short, then the way to the archived
 * ones. Nothing at all when it has no notes. The cap line has no link to the rest: the
 * list filtered to current notes is this same read, under the same cap.
 */
export function NotesSection({
  notes,
  counts,
  order,
  onShowArchived,
  onRetry,
  now,
  className,
}: NotesSectionProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const current = counts?.current ?? 0;
  if (current + (counts?.archived ?? 0) === 0) return null;
  // the read's own count, not `counts`: those come from whichever list read last, and a
  // failed refetch leaves the rows of an older read
  const capped =
    notes.status === "ready" && notes.data.nextCursor !== null
      ? notes.data
      : null;
  return (
    <section aria-labelledby={headingId} className={className}>
      <AsideHeading
        ref={headingRef}
        id={headingId}
        className="max-lg:px-4 lg:px-2"
      >
        Notes{" "}
        <span className="font-normal text-muted-foreground">{current}</span>
      </AsideHeading>
      <NotesBody
        notes={notes}
        current={current}
        onRetry={() => {
          // Try again unmounts as the notes reload; focus waits on the heading
          headingRef.current?.focus();
          onRetry();
        }}
        now={now}
      />
      {capped && (
        <p className="pt-2 text-muted-foreground max-lg:px-4 lg:px-2">
          {notesShownText(capped.items.length, capped.total, order)}
        </p>
      )}
      {counts && counts.archived > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onShowArchived}
          className={cn("mt-1", SHOW_NOTES_BUTTON)}
        >
          Show {counts.archived} archived{" "}
          {counts.archived === 1 ? "note" : "notes"}
        </Button>
      )}
    </section>
  );
}

// the word on the note keys, 8px into the box past its 1px border: 16px in below lg,
// 8px at lg with the box on the rows' edge
const SHOW_NOTES_BUTTON =
  "px-1.75 font-normal text-muted-foreground max-lg:mx-2";

const NOTE_ROW_BOX =
  "flex min-h-11 items-center gap-2.5 border-b border-rule py-2 max-lg:mx-4 lg:min-h-0 lg:px-2";

/** One placeholder per known note in the rows' own box, so the section doesn't grow when they land. */
function NoteRowsSkeleton({ rows }: { rows: number }) {
  return (
    <LoadingRegion>
      {[...Array(rows).keys()].map((row) => (
        <div key={row} className={NOTE_ROW_BOX}>
          {/* a row is as tall as its text's line at lg, where nothing else holds it open */}
          <div className="flex h-lh flex-1 items-center gap-2.5">
            <SkeletonBlock className="w-12" />
            <SkeletonBlock className="flex-1" />
            <SkeletonBlock className="w-15" />
          </div>
        </div>
      ))}
    </LoadingRegion>
  );
}

function NotesBody({
  notes,
  current,
  onRetry,
  now,
}: {
  notes: Loadable<NotesRead>;
  current: number;
  onRetry: () => void;
  now: Date;
}) {
  if (current === 0) {
    return (
      <p className="py-2 text-muted-foreground max-lg:px-4 lg:px-2">
        No current notes.
      </p>
    );
  }
  if (notes.status === "loading") return <NoteRowsSkeleton rows={current} />;
  if (notes.status === "error") {
    return (
      <ErrorState
        title="Couldn't load notes"
        description="Check your connection, then try again."
        onRetry={onRetry}
      />
    );
  }
  return (
    <ul>
      {notes.data.items.map((note) => (
        <li
          key={note.key}
          data-item-key={note.key}
          // the item table rows' hover wash, which this list continues
          className={cn(
            NOTE_ROW_BOX,
            "relative transition-colors lg:hover:bg-muted/50",
          )}
        >
          <KeyText className="shrink-0">{note.key}</KeyText>
          <RowLink
            href={paths.issue(note.key)}
            label={`${note.key} ${note.title}`}
            className="min-w-0 flex-1 truncate"
          >
            {note.title}
          </RowLink>
          <span className="shrink-0 text-muted-foreground">
            <Age iso={note.updatedAt} now={now} />
          </span>
        </li>
      ))}
    </ul>
  );
}
