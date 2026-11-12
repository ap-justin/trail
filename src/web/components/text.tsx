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

/** An issue label: an outline pill. */
export function LabelChip({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-4.5 px-1.75 text-2xs font-normal text-muted-foreground",
        className,
      )}
    >
      {name}
    </Badge>
  );
}

/** `trail` with the bot-indigo dot. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("font-semibold", className)}>
      trail<span className="text-bot">.</span>
    </span>
  );
}
