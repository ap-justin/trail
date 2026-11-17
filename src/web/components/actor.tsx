import { useCallback, useState } from "react";
import type { WebActorView } from "@/lib/api-types";
import { cn } from "@/lib/utils";

type ActorKind = WebActorView["kind"];

const kindWords: Record<ActorKind, string> = { bot: "Bot", human: "Human" };
const kindNouns: Record<ActorKind, string> = { bot: "bot", human: "person" };

/** "bot" or "person", for screen-reader text that names an actor's kind in a phrase. */
export const kindNoun = (kind: ActorKind) => kindNouns[kind];

/**
 * The actor's kind as screen-reader text, for a name shown without its avatar. Where
 * the avatar sits beside the name, its shape and accessible name already say it.
 */
export function ActorBadge({
  kind,
  className,
}: {
  kind: ActorKind;
  className?: string;
}) {
  return (
    <span data-actor-kind={kind} className={cn("sr-only", className)}>
      {kindWords[kind]}
    </span>
  );
}

/**
 * A bot's title as plain grey text after its name, ellipsized past its width with the
 * whole title in its tooltip. Nothing for a person or a bot without one.
 */
export function BotTitle({
  actor,
  className,
}: {
  actor: Pick<WebActorView, "kind" | "title">;
  className?: string;
}) {
  if (actor.kind !== "bot" || !actor.title) return null;
  return (
    <span
      title={actor.title}
      className={cn(
        "max-w-36 min-w-0 shrink-4 truncate text-xs font-normal text-muted-foreground lg:max-w-48",
        className,
      )}
    >
      {actor.title}
    </span>
  );
}

/**
 * Holds an actor's name and `BotTitle`. One line while they fit; past that the title
 * wraps under the name, and a name too long for a line of its own truncates (give it
 * `min-w-0 truncate`), so the page never overflows.
 */
export const actorNameGroup =
  "inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5";

/**
 * An actor's name, then `BotTitle`, in an `actorNameGroup` with the name truncating.
 * The space keeps the parts apart in copied text and textContent; a flex row draws none.
 */
export function ActorName({
  actor,
  className,
  nameClassName,
  titleClassName,
}: {
  actor: Pick<WebActorView, "name" | "kind" | "title">;
  className?: string;
  nameClassName?: string;
  titleClassName?: string;
}) {
  return (
    <span className={cn(actorNameGroup, className)}>
      <span className={cn("min-w-0 truncate", nameClassName)}>
        {actor.name}
      </span>{" "}
      <BotTitle actor={actor} className={titleClassName} />
    </span>
  );
}

export const avatarSizes = {
  xs: "size-4.5 text-2xs",
  sm: "size-6 text-2xs",
  md: "size-7 text-2xs",
  lg: "size-9 text-xs",
} as const;

/**
 * Bots: first letter. People: first and last initials, with dots and underscores
 * splitting words too: a person who signs in by email is named for the part of their
 * address before the @ (`syncEmailActor` in src/server/auth/identity.ts), so dana.okafor is DO.
 */
function initials(actor: Pick<WebActorView, "name" | "kind">): string {
  const words = actor.name
    .trim()
    .split(/[\s._]+/)
    .filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  if (actor.kind === "bot" || words.length < 2) return first.toUpperCase();
  return `${first}${words.at(-1)?.[0] ?? ""}`.toUpperCase();
}

/**
 * The actor's initials on a tinted ground, with their photo stacked on top when there
 * is one: a rounded square for a bot, a circle for a person. A bot's photo, once shown,
 * gets a thin teal frame, so it still reads as a bot at 18px. The initials show while
 * the photo loads and stay if it fails; once it loads they go, so a transparent photo
 * never shows them through.
 * The one mark of an actor's kind, so it is an image named for it: "Alpha, bot".
 * `loading="eager"` for an avatar at the top of its screen (the account panel); lists
 * keep the lazy default.
 */
export function ActorAvatar({
  actor,
  size = "sm",
  loading = "lazy",
  className,
}: {
  actor: Pick<WebActorView, "name" | "kind" | "photoUrl">;
  size?: keyof typeof avatarSizes;
  loading?: "eager" | "lazy";
  className?: string;
}) {
  const bot = actor.kind === "bot";
  // keyed by URL, so a new photo gets its own try after an old one failed
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // hidden on load rather than a ground on the img: a sized img paints its
  // background before the photo arrives, which would cover the initials while loading
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const photoUrl =
    actor.photoUrl && actor.photoUrl !== failedUrl ? actor.photoUrl : null;
  const photoShown = photoUrl !== null && photoUrl === loadedUrl;
  // a photo this page already loaded is complete at attach, before its load event; taking it
  // then skips a frame of initials. After a hard reload it isn't, so initials may show for a
  // frame.
  const takeIfComplete = useCallback(
    (img: HTMLImageElement | null) => {
      if (img?.complete && img.naturalWidth > 0) setLoadedUrl(photoUrl);
    },
    [photoUrl],
  );
  return (
    <span
      role="img"
      aria-label={`${actor.name}, ${kindNoun(actor.kind)}`}
      data-actor-kind={actor.kind}
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden font-semibold select-none",
        avatarSizes[size],
        bot
          ? "rounded-md bg-bot-muted text-bot"
          : "rounded-full bg-muted text-muted-foreground",
        // a border, not a ring: an outer ring grows past the box, an inset one paints under the img
        bot && photoShown && "border border-bot",
        className,
      )}
    >
      {!photoShown && (
        <span className="col-start-1 row-start-1">{initials(actor)}</span>
      )}
      {photoUrl && (
        // keyed: a reused img keeps painting the old photo while the new one loads,
        // unframed and over the initials
        <img
          key={photoUrl}
          ref={takeIfComplete}
          src={photoUrl}
          alt=""
          loading={loading}
          onLoad={() => setLoadedUrl(photoUrl)}
          onError={() => setFailedUrl(photoUrl)}
          // hidden, not unmounted, until shown: it still has to load, and a photo the
          // browser draws as its bytes arrive would cover the initials half-drawn, unframed
          className={cn(
            "col-start-1 row-start-1 size-full object-cover",
            !photoShown && "opacity-0",
          )}
        />
      )}
    </span>
  );
}
