import { useId, useRef } from "react";
import { RowLink } from "@/components/app-link";
import { ErrorState, ListSkeleton } from "@/components/states";
import { Age, AsideHeading } from "@/components/status-updates";
import { KeyText } from "@/components/text";
import { Button } from "@/components/ui/button";
import type { WebItemCountsView, WebItemRowView } from "@/lib/api-types";
import type { Loadable } from "@/lib/loadable";
import { paths } from "@/lib/paths";

export type NotesSectionProps = {
  /** The current notes, in the list's order. */
  notes: Loadable<WebItemRowView[]>;
  /** Null until the page's list first loads them; the section then stands on `notes` alone. */
  counts: WebItemCountsView["notes"] | null;
  /** Lists the archived notes in the page's own item list. */
  onShowArchived: () => void;
  onRetry: () => void;
  now: Date;
  className?: string;
};

/**
 * A product's or project's current notes under the work list: key, title and age a row,
 * then the way to the archived ones. Nothing at all when it has no notes.
 */
export function NotesSection({
  notes,
  counts,
  onShowArchived,
  onRetry,
  now,
  className,
}: NotesSectionProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const current =
    counts?.current ?? (notes.status === "ready" ? notes.data.length : 0);
  if (current + (counts?.archived ?? 0) === 0) return null;
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
      {counts && counts.archived > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onShowArchived}
          className="mt-1 font-normal text-muted-foreground max-lg:mx-4 lg:ml-0.5"
        >
          Show {counts.archived} archived{" "}
          {counts.archived === 1 ? "note" : "notes"}
        </Button>
      )}
    </section>
  );
}

function NotesBody({
  notes,
  current,
  onRetry,
  now,
}: {
  notes: Loadable<WebItemRowView[]>;
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
  if (notes.status === "loading")
    return <ListSkeleton className="px-4 lg:px-2" />;
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
      {notes.data.map((note) => (
        <li
          key={note.key}
          data-item-key={note.key}
          className="relative flex min-h-11 items-center gap-2.5 border-b border-rule py-2 max-lg:mx-4 lg:min-h-0 lg:px-2"
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
