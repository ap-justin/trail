import { Wordmark } from "@/components/text";
import { cn } from "@/lib/utils";

/**
 * Three pills stepping up to the right; the top one is the head. Sized by
 * `className` (height; width follows the viewBox). `mono` paints all three in the
 * current text colour.
 */
export function Mark({
  className,
  mono = false,
}: {
  className?: string;
  mono?: boolean;
}) {
  const body = mono ? "fill-current" : "fill-foreground";
  return (
    <svg
      viewBox="0 4 60 52"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <rect x="0" y="44" width="36" height="12" rx="6" className={body} />
      <rect x="12" y="24" width="36" height="12" rx="6" className={body} />
      <rect
        x="24"
        y="4"
        width="36"
        height="12"
        rx="6"
        className={mono ? "fill-current" : "fill-bot"}
      />
    </svg>
  );
}

/** The mark beside the wordmark; the mark is `h-4.5` unless `markClassName` says otherwise. */
export function Logo({
  className,
  markClassName = "h-4.5",
  wordmarkClassName,
}: {
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <Mark className={markClassName} />
      <Wordmark className={wordmarkClassName} />
    </span>
  );
}
