import { BotIcon, UserIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { WebActorView } from "@/lib/api-types";
import { cn } from "@/lib/utils";

type ActorKind = WebActorView["kind"];

/**
 * Bot or Human, always as a word with its glyph: indigo for bots, outline for people.
 * The word carries the meaning, so the rule never rests on colour alone.
 */
export function ActorBadge({
  kind,
  className,
}: {
  kind: ActorKind;
  className?: string;
}) {
  const bot = kind === "bot";
  const Icon = bot ? BotIcon : UserIcon;
  return (
    <Badge
      variant={bot ? "secondary" : "outline"}
      data-actor-kind={kind}
      className={cn(
        "h-4.5 gap-0.75 rounded-sm px-1.5 text-2xs",
        bot ? "bg-bot-muted text-bot" : "text-muted-foreground",
        className,
      )}
    >
      <Icon data-icon="inline-start" aria-hidden="true" />
      {bot ? "Bot" : "Human"}
    </Badge>
  );
}

/**
 * A bot's title as a pill, between its name and its Bot badge, inside `actorNameGroup`;
 * nothing for a person or a bot without one. Capped in width, it ellipsizes and keeps the
 * whole title in its tooltip.
 * `surface="card"` sits it on the background inside a muted comment header.
 */
export function BotTitle({
  actor,
  surface = "muted",
  className,
}: {
  actor: Pick<WebActorView, "kind" | "title">;
  surface?: "muted" | "card";
  className?: string;
}) {
  if (actor.kind !== "bot" || !actor.title) return null;
  return (
    <span
      title={actor.title}
      className={cn(
        "inline-flex h-4.5 max-w-36 min-w-0 shrink-4 items-center rounded-4xl border border-border px-2 text-2xs leading-none font-normal text-secondary-foreground lg:max-w-48",
        surface === "card" ? "bg-background" : "bg-muted",
        className,
      )}
    >
      <span className="truncate">{actor.title}</span>
    </span>
  );
}

/**
 * Holds an actor's name, `BotTitle` and badge. One line while they fit; past that the
 * pill and badge wrap under the name, and a name too long for a line of its own
 * truncates (give it `min-w-0 truncate`), so the page never overflows and the pill is
 * never squeezed past its label.
 */
export const actorNameGroup =
  "inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5";

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
 * gets a thin indigo frame, so it still reads as a bot at 18px. The initials show while
 * the photo loads and stay if it fails; once it loads they go, so a transparent photo
 * never shows them through.
 * Decorative: the name always sits beside it.
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
      aria-hidden="true"
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
