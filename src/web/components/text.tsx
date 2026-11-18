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
 * wraps, so the name beside it (`min-w-0 truncate`) is what gives way. Mono on `bg-muted`,
 * where `LabelChip` is sans on `bg-accent`, so it reads as a key and not a label.
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
        "shrink-0 rounded-sm bg-muted px-1.5 font-mono text-2xs font-medium whitespace-nowrap text-muted-foreground",
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

/** `trail` with the bot-teal dot. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-semibold", className)}>
      trail<span className="text-bot">.</span>
    </span>
  );
}
