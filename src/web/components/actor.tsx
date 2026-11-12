import { BotIcon, UserIcon } from "lucide-react";
import { useState } from "react";
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

export const avatarSizes = {
  xs: "size-4.5 text-2xs",
  sm: "size-6 text-2xs",
  md: "size-7 text-2xs",
  lg: "size-9 text-xs",
} as const;

/** Bots: first letter. People: first and last initials. */
function initials(actor: Pick<WebActorView, "name" | "kind">): string {
  const words = actor.name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  if (actor.kind === "bot" || words.length < 2) return first.toUpperCase();
  return `${first}${words.at(-1)?.[0] ?? ""}`.toUpperCase();
}

/**
 * The actor's initials on a tinted ground, with their photo stacked on top when there
 * is one: a rounded square for a bot, a circle for a person. A bot's photo gets a thin
 * indigo frame, so it still reads as a bot at 18px. The initials show while the photo
 * loads and stay when it fails.
 * Decorative: the name always sits beside it.
 * `loading="eager"` for avatars that are always on screen (the shell's account menu
 * and panel); lists keep the lazy default.
 */
export function ActorAvatar({
  actor,
  size = "sm",
  loading = "lazy",
  className,
}: {
  actor: Pick<WebActorView, "name" | "kind"> & {
    photoUrl?: WebActorView["photoUrl"];
  };
  size?: keyof typeof avatarSizes;
  loading?: "eager" | "lazy";
  className?: string;
}) {
  const bot = actor.kind === "bot";
  // keyed by URL, so a new photo gets its own try after an old one failed
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const photoUrl =
    actor.photoUrl && actor.photoUrl !== failedUrl ? actor.photoUrl : null;
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
        bot && photoUrl && "border border-bot",
        className,
      )}
    >
      <span className="col-start-1 row-start-1">{initials(actor)}</span>
      {photoUrl && (
        <img
          src={photoUrl}
          alt=""
          loading={loading}
          decoding="async"
          onError={() => setFailedUrl(photoUrl)}
          className="col-start-1 row-start-1 size-full object-cover"
        />
      )}
    </span>
  );
}
