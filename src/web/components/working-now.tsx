import { useId } from "react";
import { ActorAvatar } from "@/components/actor";
import { AppLink, textLinkFocus } from "@/components/app-link";
import { KeyText } from "@/components/text";
import type { WebWorkingNowView } from "@/lib/api-types";
import { paths } from "@/lib/paths";
import { cn } from "@/lib/utils";

/** Entries shown from lg. */
export const WORKING_NOW_CAP = 4;
/** The longest bot name the phone row shows whole beside a second entry. */
export const WORKING_NOW_PHONE_NAME_MAX = 8;

const fitsWhole = (name: string) =>
  [...name].length <= WORKING_NOW_PHONE_NAME_MAX;

/**
 * The top of the feed: each bot at work as its square teal avatar, its name and the
 * item key, linking to the item. Four entries from lg; below, two when both names fit
 * whole and one otherwise. Then "+N" for the rest of `total`, which counts past the
 * entries the server sends. Nothing at all while no bot has an item in progress.
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
  // css can't count characters, so the phone's share is decided on the names
  const phoneShown =
    shown.length >= 2 &&
    shown.slice(0, 2).every(({ bot }) => fitsWhole(bot.name))
      ? 2
      : Math.min(shown.length, 1);
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
            className={cn("min-w-0", index >= phoneShown && "max-lg:hidden")}
          >
            <AppLink
              href={paths.issue(item.key)}
              aria-label={`${bot.name} ${item.key}, ${item.title}, bot`}
              className={cn(
                textLinkFocus,
                "flex min-h-11 min-w-0 items-center gap-1.5 pr-2 pl-1 hover:bg-accent lg:min-h-7",
              )}
            >
              <ActorAvatar actor={bot} size="xs" />
              {/* the name gives way first: the key is what the link opens; below lg a
                  name that fits whole keeps every letter */}
              <span
                className={cn(
                  "min-w-0 truncate font-medium text-foreground",
                  fitsWhole(bot.name) && "max-lg:shrink-0",
                )}
              >
                {bot.name}
              </span>
              <KeyText>{item.key}</KeyText>
            </AppLink>
          </li>
        ))}
        <MoreCount count={total - phoneShown} className="lg:hidden" />
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
