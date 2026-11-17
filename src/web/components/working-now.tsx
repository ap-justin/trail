import { useId } from "react";
import { ActorAvatar } from "@/components/actor";
import { AppLink, textLinkFocus } from "@/components/app-link";
import { KeyText } from "@/components/text";
import type { WebWorkingNowView } from "@/lib/api-types";
import { paths } from "@/lib/paths";
import { cn } from "@/lib/utils";

/** Entries shown from lg; below lg, `WORKING_NOW_PHONE_CAP` of them. */
export const WORKING_NOW_CAP = 4;
export const WORKING_NOW_PHONE_CAP = 2;

/**
 * The top of the feed: each bot at work as its square teal avatar, its name and the
 * item key, linking to the item. Four entries from lg and two below, then "+N" for the
 * rest of `total`, which counts past the entries the server sends. Nothing at all while
 * no bot has an item in progress.
 */
export function WorkingNow({
  workingNow,
  className,
}: {
  workingNow: WebWorkingNowView | undefined;
  className?: string;
}) {
  const headingId = useId();
  if (!workingNow || workingNow.total === 0) return null;
  const { total, entries } = workingNow;
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
            className={cn(
              "min-w-0",
              index >= WORKING_NOW_PHONE_CAP && "max-lg:hidden",
            )}
          >
            <AppLink
              href={paths.issue(item.key)}
              aria-label={`${bot.name} ${item.key}, ${item.title}, worked on by ${bot.name}, bot`}
              className={cn(
                textLinkFocus,
                "flex min-h-11 min-w-0 items-center gap-1.5 pr-2 pl-1 hover:bg-accent lg:min-h-7",
              )}
            >
              <ActorAvatar actor={bot} size="xs" />
              {/* the name gives way first: the key is what the link opens */}
              <span className="min-w-0 truncate font-medium text-foreground">
                {bot.name}
              </span>
              <KeyText>{item.key}</KeyText>
            </AppLink>
          </li>
        ))}
        <MoreCount
          count={total - Math.min(shown.length, WORKING_NOW_PHONE_CAP)}
          className="lg:hidden"
        />
        <MoreCount count={total - shown.length} className="max-lg:hidden" />
      </ul>
    </section>
  );
}

function MoreCount({ count, className }: { count: number; className: string }) {
  if (count <= 0) return null;
  return (
    <li
      className={cn("shrink-0 px-1.5 text-xs text-muted-foreground", className)}
      data-more-count
    >
      +{count} <span className="sr-only">more</span>
    </li>
  );
}
