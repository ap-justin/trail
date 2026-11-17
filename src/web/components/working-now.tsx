import { useId } from "react";
import { ActorAvatar } from "@/components/actor";
import { AppLink } from "@/components/app-link";
import { KeyText } from "@/components/text";
import type { WebActorView, WebItemRowView } from "@/lib/api-types";
import { paths } from "@/lib/paths";
import { cn } from "@/lib/utils";

/** A bot and the in-progress item assigned to it. */
export type WorkingNowEntry = {
  bot: WebActorView;
  item: Pick<WebItemRowView, "key" | "title">;
};

/** Entries shown from lg; below lg, `WORKING_NOW_PHONE_CAP` of them. */
export const WORKING_NOW_CAP = 4;
export const WORKING_NOW_PHONE_CAP = 2;

/**
 * The items in progress with a bot assignee, most recently updated first. Items a
 * person holds, or nobody does, are not bot work.
 */
export function workingNowEntries(items: WebItemRowView[]): WorkingNowEntry[] {
  return items
    .filter((item) => item.status === "in_progress")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .flatMap(({ key, title, assignee }) =>
      assignee?.kind === "bot" ? [{ bot: assignee, item: { key, title } }] : [],
    );
}

/**
 * The top of the feed: each bot at work as its square teal avatar plus the item key,
 * linking to the item. Four entries from lg and two below, then "+N" for the rest.
 * Nothing at all while no bot has an item in progress.
 */
export function WorkingNow({
  entries,
  className,
}: {
  entries: WorkingNowEntry[];
  className?: string;
}) {
  const headingId = useId();
  if (entries.length === 0) return null;
  const shown = entries.slice(0, WORKING_NOW_CAP);
  return (
    <section
      aria-labelledby={headingId}
      className={cn("flex min-w-0 items-center gap-3", className)}
    >
      <h2
        id={headingId}
        className="shrink-0 text-xs font-normal text-muted-foreground"
      >
        Working now
      </h2>
      <ul className="flex min-w-0 items-center gap-1">
        {shown.map(({ bot, item }, index) => (
          <li
            key={item.key}
            className={cn(index >= WORKING_NOW_PHONE_CAP && "max-lg:hidden")}
          >
            <AppLink
              href={paths.issue(item.key)}
              aria-label={`${bot.name} is working on ${item.key} ${item.title}`}
              className="flex min-h-11 items-center gap-1.5 rounded-md px-1.5 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:min-h-8"
            >
              <ActorAvatar actor={bot} size="xs" />
              <KeyText className="text-foreground">{item.key}</KeyText>
            </AppLink>
          </li>
        ))}
        <MoreCount
          count={entries.length - WORKING_NOW_PHONE_CAP}
          className="lg:hidden"
        />
        <MoreCount
          count={entries.length - WORKING_NOW_CAP}
          className="max-lg:hidden"
        />
      </ul>
    </section>
  );
}

function MoreCount({ count, className }: { count: number; className: string }) {
  if (count <= 0) return null;
  return (
    <li
      className={cn("px-1.5 text-xs text-muted-foreground", className)}
      data-more-count
    >
      +{count} <span className="sr-only">more</span>
    </li>
  );
}
