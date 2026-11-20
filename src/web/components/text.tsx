import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Keys, URLs and @usernames: Geist Mono, so they scan and read as what to copy. */
export function KeyText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-mono text-xs font-medium whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A product key after the product's name: a small muted mono pill that never truncates or
 * wraps, so the name beside it (`min-w-0 truncate`) is what gives way. Mono on `bg-muted` with a
 * `ring-border` hairline so it holds on any surface, where `LabelChip` is sans on `bg-accent`, so
 * it reads as a key and not a label.
 */
export function KeyPill({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      data-key-pill
      className={cn(
        "shrink-0 rounded-sm bg-muted px-1.5 ring-1 ring-inset ring-border font-mono text-2xs font-medium whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** An issue label: the neutral tag chip. */
export function LabelChip({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <Badge variant="tag" className={className}>
      {name}
    </Badge>
  );
}

/** After a team's name and key: the outline chip "Asked for no reply" wears, neutral, so the one hue stays on bots. */
export function TeamBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      data-team-badge
      className={cn(
        "h-4.5 bg-background px-1.75 text-2xs font-normal text-muted-foreground",
        className,
      )}
    >
      Team
    </Badge>
  );
}

/** `trail` with the bot-teal dot. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-semibold", className)}>
      trail<span className="text-bot">.</span>
    </span>
  );
}
