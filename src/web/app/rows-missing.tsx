/**
 * Says a list stopped at its page cap (`ITEM_PAGES_MAX` in lib/queries.ts), so a header
 * count above the rows isn't read as wrong. Renders nothing when every row was read.
 */
export function RowsMissing({
  list,
  shown,
}: {
  list: { nextCursor: string | null } | undefined;
  shown: number;
}) {
  if (!list || list.nextCursor === null) return null;
  return (
    <p className="px-4 py-3 text-xs text-muted-foreground lg:px-6">
      Only the first {shown.toLocaleString("en-US")} items are shown.
    </p>
  );
}
