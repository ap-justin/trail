import type { ReactNode, Ref } from "react";
import {
  ActorAvatar,
  ActorBadge,
  actorNameGroup,
  BotTitle,
} from "@/components/actor";
import { Markdown } from "@/components/markdown";
import { MarkdownText } from "@/components/markdown-text";
import { ErrorState, ListSkeleton } from "@/components/states";
import { HealthPill, type ProjectHealth } from "@/components/status";
import type {
  WebStatusUpdatePageView,
  WebStatusUpdateView,
} from "@/lib/api-types";
import type { Loadable } from "@/lib/loadable";
import { formatAbsolute, formatDate, formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

/** `41m ago`, `3h ago`; a date or `just now` stands alone. */
function ago(iso: string, now: Date): string {
  const relative = formatRelative(iso, now);
  return /^\d+[mh]$/.test(relative) ? `${relative} ago` : relative;
}

/** A relative time with the absolute one in its tooltip; `ago` adds the word after `41m`. */
export function Age({
  iso,
  now,
  ago: withAgo = false,
}: {
  iso: string;
  now: Date;
  ago?: boolean;
}) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {withAgo ? ago(iso, now) : formatRelative(iso, now)}
    </time>
  );
}

/** A project's target date, `Dec 4`. */
export function TargetDate({ date, now }: { date: string; now: Date }) {
  return <time dateTime={date}>{formatDate(date, now)}</time>;
}

/**
 * Health with its word, drawn only beside a status update: the health is the latest
 * update's, so with none there is nothing to show.
 */
export function UpdateHealth({
  of,
  className,
}: {
  of: {
    health: ProjectHealth | null;
    latestStatusUpdate: WebStatusUpdateView | null;
  };
  className?: string;
}) {
  if (!of.latestStatusUpdate || !of.health) return null;
  return <HealthPill health={of.health} className={className} />;
}

export const NO_STATUS_UPDATE = "No status update yet";

/**
 * The latest update on a list. `table`: author, title pill, badge and age over one line
 * of it. `card`: two lines of it with the author under them. "No status update yet"
 * with none. `badge={false}` drops the Bot badge where the column is narrow.
 */
export function LatestUpdate({
  update,
  now,
  layout,
  badge = true,
}: {
  update: WebStatusUpdateView | null;
  now: Date;
  layout: "table" | "card";
  badge?: boolean;
}) {
  if (!update) {
    return <p className="text-muted-foreground">{NO_STATUS_UPDATE}</p>;
  }
  const author = (
    <div className="flex min-w-0 items-center gap-2">
      <ActorAvatar actor={update.author} size="xs" />
      <span className={actorNameGroup}>
        <span
          className={cn(
            "min-w-0 truncate",
            layout === "table" && "font-medium",
          )}
        >
          {update.author.name}
        </span>{" "}
        <BotTitle actor={update.author} />{" "}
        {badge && <ActorBadge kind={update.author.kind} />}
      </span>
      <span
        className={cn(
          "shrink-0 whitespace-nowrap text-muted-foreground",
          layout === "card" && "ml-auto",
        )}
      >
        <Age iso={update.createdAt} now={now} ago />
      </span>
    </div>
  );
  if (layout === "card") {
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="line-clamp-2 text-muted-foreground">
          <MarkdownText source={update.body} />
        </p>
        {author}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {author}
      <p className="truncate text-muted-foreground">
        <MarkdownText source={update.body} />
      </p>
    </div>
  );
}

/** A 32px aside heading over a rule; focusable from script, for focus a removed button had. */
export function AsideHeading({
  id,
  children,
  className,
  ref,
}: {
  id: string;
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLHeadingElement>;
}) {
  return (
    <h2
      ref={ref}
      id={id}
      tabIndex={-1}
      className={cn(
        "flex h-8 items-center gap-1.5 border-b font-medium outline-none",
        className,
      )}
    >
      {children}
    </h2>
  );
}

function StatusUpdateItem({ update }: { update: WebStatusUpdateView }) {
  return (
    <li className="flex flex-col gap-1 border-b py-3 last:border-b-0 max-lg:px-4 max-lg:py-3.5 max-lg:last:border-b">
      {/* not ActorName: here the title rides the date's row, under the name */}
      <div className="flex min-w-0 items-center gap-2">
        <ActorAvatar actor={update.author} size="xs" />
        <span className="min-w-0 truncate font-medium">
          {update.author.name}
        </span>
        <ActorBadge kind={update.author.kind} />
        <HealthPill health={update.health} className="ml-auto" />
      </div>
      <div className="-mt-0.5 flex min-w-0 items-center gap-2 pl-6.5 text-xs text-muted-foreground">
        <BotTitle actor={update.author} />
        <time dateTime={update.createdAt} className="shrink-0">
          {formatAbsolute(update.createdAt)}
        </time>
      </div>
      <Markdown>{update.body}</Markdown>
    </li>
  );
}

/** A product's or project's status updates, newest first. */
export function StatusUpdateList({
  updates,
  onRetry,
}: {
  updates: Loadable<WebStatusUpdatePageView>;
  onRetry: () => void;
}) {
  if (updates.status === "loading") return <ListSkeleton />;
  if (updates.status === "error") {
    return (
      <ErrorState
        title="Couldn't load status updates"
        description="Check your connection, then try again."
        onRetry={onRetry}
      />
    );
  }
  if (updates.data.items.length === 0) {
    return (
      <p className="py-3 text-muted-foreground max-lg:px-4">
        {NO_STATUS_UPDATE}
      </p>
    );
  }
  return (
    <ul>
      {updates.data.items.map((update) => (
        <StatusUpdateItem key={update.id} update={update} />
      ))}
    </ul>
  );
}
