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

const avatarSizes = {
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
 * The actor's photo, or initials when there is none or it fails to load, on a tinted
 * ground: a rounded square for a bot, a circle for a person.
 * Decorative: the name always sits beside it.
 */
export function ActorAvatar({
  actor,
  size = "sm",
  className,
}: {
  actor: Pick<WebActorView, "name" | "kind"> & {
    photoUrl?: WebActorView["photoUrl"];
  };
  size?: keyof typeof avatarSizes;
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
        className,
      )}
    >
      {photoUrl ? (
        <img
          src={photoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(photoUrl)}
          className="size-full object-cover"
        />
      ) : (
        initials(actor)
      )}
    </span>
  );
}
