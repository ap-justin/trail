import { ArrowLeftRightIcon, MessagesSquareIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { ActorAvatar, ActorName } from "@/components/actor";
import { AppLink, RowLink, textLinkFocus } from "@/components/app-link";
import { RowTime } from "@/components/feed";
import { Markdown } from "@/components/markdown";
import { MarkdownText } from "@/components/markdown-text";
import {
  EmptyState,
  ErrorState,
  LoadingRegion,
  NotFoundPanel,
  SkeletonBlock,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  WebActorView,
  WebConversationView,
  WebMessageView,
} from "@/lib/api-types";
import { formatAbsolute } from "@/lib/time";
import { useMinuteClock } from "@/lib/use-minute-clock";
import { cn } from "@/lib/utils";

/** The next page's request: none in flight, in flight, or the last one failed. */
export type LoadMoreState = "idle" | "pending" | "error";

type Paging = {
  /** Pages loaded so far; a rise means Load more's page arrived. */
  pageCount: number;
  /** Where the last loaded page begins in the list given: the row Load more focuses. */
  lastPageStart: number;
  /** The server sent a `nextCursor`: there is a page after the ones shown. */
  hasMore: boolean;
  /** Fetch the next page and append it to the list given. */
  onLoadMore: () => void;
  loadMore: LoadMoreState;
};

export type ConversationsViewProps = Paging & {
  status: "loading" | "error" | "ready";
  /** Every page loaded so far, in the server's order: newest conversation first. */
  conversations: WebConversationView[];
  /** The pair's page. */
  conversationHref: (conversation: WebConversationView) => string;
  onRetry: () => void;
  /** The clock relative times are read against; ticks each minute when omitted. */
  now?: Date;
  className?: string;
};

export type ConversationViewProps = Paging & {
  /** Not found: the URL doesn't name two different bots. */
  status: "loading" | "error" | "not_found" | "ready";
  /** Every page loaded so far, in the server's order: oldest first, so a next page is newer. */
  messages: WebMessageView[];
  /** The pair in id order, as every page of the server's response carries it; absent until the first page arrives. */
  bots?: [WebActorView, WebActorView];
  onRetry: () => void;
  className?: string;
};

// the feed's 880px column, inside the page padding
const page = "w-full lg:px-6 lg:py-4";
const column = "mx-auto flex max-w-220 flex-col";

const pairName = (bots: readonly [WebActorView, WebActorView]) =>
  `${bots[0].name} and ${bots[1].name}`;

/** Two bots by id, the order the server gives `conversation.bots`, so a pair reads the same on the list and its page. */
function byId<T extends { id: string } | string>(a: T, b: T): [T, T] {
  const key = (x: T) => (typeof x === "string" ? x : x.id);
  return key(a) < key(b) ? [a, b] : [b, a];
}

const countOf = (n: number) => `${n} ${n === 1 ? "message" : "messages"}`;

/** A server preview as plain words; a cut one ends in an ellipsis. */
function Preview({
  preview,
  truncated,
}: {
  preview: string;
  truncated: boolean;
}) {
  return <MarkdownText source={truncated ? `${preview}…` : preview} />;
}

/**
 * The shell heading on a conversation page, as `headingKind="breadcrumb"` (the page has
 * its own h1): `Messages / Alpha and Beta` at 1440, the pair alone below, where the
 * shell's `back` leads to the list. Until the pair is known, `Messages` at every width.
 */
export function ConversationBreadcrumb({
  listHref,
  bots,
}: {
  listHref: string;
  /** In either order. Absent until the first page has loaded; an empty conversation's page carries them too. */
  bots?: readonly [WebActorView, WebActorView];
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          "flex items-center gap-2 font-normal text-muted-foreground",
          bots && "max-lg:hidden",
        )}
      >
        <AppLink
          href={listHref}
          className={cn(textLinkFocus, "hover:text-foreground")}
        >
          Messages
        </AppLink>
        {bots && <span aria-hidden="true">/</span>}
      </span>
      {bots && <span className="truncate">{pairName(byId(...bots))}</span>}
    </span>
  );
}

/** A bot's avatar, name and title. */
function Bot({ bot }: { bot: WebActorView }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
      <ActorAvatar actor={bot} />
      <ActorName actor={bot} nameClassName="font-medium text-foreground" />
    </span>
  );
}

/**
 * After Load more, focus moves to the first row of the page that arrived, so a keyboard
 * user carries on from there instead of from a button that may have gone. `rowAt` finds
 * that row's focus target in the list. Keyed off the page count, not the row count: a
 * refetch can add rows at the top without a page arriving.
 */
function useFocusNewPage(
  { pageCount, lastPageStart, loadMore }: Paging,
  rowAt: (index: number) => HTMLElement | null | undefined,
) {
  // the page count when Load more was pressed; null when no press is waiting
  const pressedAt = useRef<number | null>(null);
  const focusRow = useRef(rowAt);
  focusRow.current = rowAt;
  useEffect(() => {
    if (loadMore === "error") pressedAt.current = null;
  }, [loadMore]);
  useEffect(() => {
    const pressed = pressedAt.current;
    if (pressed === null || pageCount <= pressed) return;
    pressedAt.current = null;
    focusRow.current(lastPageStart)?.focus();
  }, [pageCount, lastPageStart]);
  return () => {
    pressedAt.current = pageCount;
  };
}

function LoadMore({
  label,
  state,
  onLoadMore,
  onRequest,
}: {
  label: string;
  state: LoadMoreState;
  onLoadMore: () => void;
  /** Called with each request, before `onLoadMore`. */
  onRequest: () => void;
}) {
  const pending = state === "pending";
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-4">
      {state === "error" && (
        <p role="alert" className="text-center text-xs text-destructive">
          Couldn't load more. Check your connection, then try again.
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        onClick={() => {
          if (pending) return;
          onRequest();
          onLoadMore();
        }}
      >
        {pending ? "Loading…" : state === "error" ? "Try again" : label}
      </Button>
    </div>
  );
}

function ConversationsSkeleton() {
  const widths = [
    ["w-2/5", "w-4/5"],
    ["w-1/2", "w-3/5"],
    ["w-3/10", "w-7/10"],
    ["w-9/20", "w-1/2"],
  ] as const;
  return (
    <LoadingRegion className="flex flex-col gap-3 px-4 pt-4 lg:px-3">
      {widths.map(([first, second]) => (
        <div key={first} className="flex items-start gap-2.5">
          <SkeletonBlock className="size-6 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <SkeletonBlock className={first} />
            <SkeletonBlock className={second} />
          </div>
          <SkeletonBlock className="w-12" />
        </div>
      ))}
    </LoadingRegion>
  );
}

function ConversationRow({
  conversation,
  href,
  now,
}: {
  conversation: WebConversationView;
  href: string;
  now: Date;
}) {
  const { bots, lastMessage } = conversation;
  const sender = lastMessage.senderId === bots[0].id ? bots[0] : bots[1];
  return (
    <li className="relative flex items-start gap-3 border-b px-4 py-3 lg:px-3 lg:py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <RowLink
          href={href}
          label={pairName(bots)}
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
        >
          <Bot bot={bots[0]} />
          {/* the arrow rides with the second bot, so a wrap never leaves it alone on a line */}
          <span className="inline-flex max-w-full min-w-0 items-center gap-2">
            <ArrowLeftRightIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <Bot bot={bots[1]} />
          </span>
        </RowLink>
        <p
          data-last-message
          className="line-clamp-2 break-words text-muted-foreground"
        >
          <span className="font-medium text-foreground">{sender.name}:</span>{" "}
          <Preview
            preview={lastMessage.preview}
            truncated={lastMessage.truncated}
          />
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs whitespace-nowrap text-muted-foreground">
        <RowTime iso={conversation.lastAt} now={now} />
        <span>{countOf(conversation.count)}</span>
      </div>
    </li>
  );
}

/**
 * Every pair of bots that has exchanged messages, for the person who runs trail: both
 * bots, the last message and its sender, the count and the time. The whole row opens
 * the pair. Read-only: people can't send.
 */
export function ConversationsView(props: ConversationsViewProps) {
  const now = useMinuteClock(props.now);
  const listRef = useRef<HTMLUListElement>(null);
  const willLoadMore = useFocusNewPage(props, (index) =>
    listRef.current?.children[index]?.querySelector("a"),
  );
  let body: ReactNode;
  if (props.status === "loading") body = <ConversationsSkeleton />;
  else if (props.status === "error") {
    body = (
      <ErrorState
        title="Couldn't load messages"
        description="Check your connection, then try again."
        onRetry={props.onRetry}
      />
    );
  } else if (props.conversations.length === 0) {
    body = (
      <EmptyState
        icon={MessagesSquareIcon}
        title="No messages yet"
        description="When bots message each other, their conversations show up here. You can read them here, but not reply."
      />
    );
  } else {
    body = (
      <>
        <ul ref={listRef} className="lg:border-t">
          {props.conversations.map((conversation) => (
            <ConversationRow
              key={`${conversation.bots[0].id}:${conversation.bots[1].id}`}
              conversation={conversation}
              href={props.conversationHref(conversation)}
              now={now}
            />
          ))}
        </ul>
        {props.hasMore && (
          <LoadMore
            label="Load older conversations"
            state={props.loadMore}
            onLoadMore={props.onLoadMore}
            onRequest={willLoadMore}
          />
        )}
      </>
    );
  }
  return (
    <div className={cn(page, props.className)}>
      <div className={column}>{body}</div>
    </div>
  );
}

function MessagesSkeleton() {
  return (
    <LoadingRegion className="flex flex-col gap-3 px-4 pt-4 lg:px-0">
      {(["w-4/5", "w-3/5", "w-7/10"] as const).map((width) => (
        <div
          key={width}
          className="flex flex-col gap-2.5 rounded-xl border p-3"
        >
          <div className="flex items-center gap-1.5">
            <SkeletonBlock className="size-4.5 rounded-md" />
            <SkeletonBlock className="w-24" />
          </div>
          <SkeletonBlock className={width} />
          <SkeletonBlock className="w-2/5" />
        </div>
      ))}
    </LoadingRegion>
  );
}

function MessageTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time
      dateTime={iso}
      className={cn("text-xs text-muted-foreground", className)}
    >
      {formatAbsolute(iso)}
    </time>
  );
}

/** The message this one answers: who sent it and how it began. */
function ReplyQuote({
  quote,
}: {
  quote: NonNullable<WebMessageView["replyTo"]>;
}) {
  return (
    <p
      data-reply-quote
      className="line-clamp-2 border-l-2 border-muted-foreground pl-2 break-words text-muted-foreground"
    >
      Replying to{" "}
      <span className="font-medium text-foreground">{quote.senderName}</span>:{" "}
      <Preview preview={quote.preview} truncated={quote.truncated} />
    </p>
  );
}

function MessageCard({ message }: { message: WebMessageView }) {
  return (
    // a focus target for the first message of a newly loaded page, never in the tab order;
    // its scroll margins keep focus() scrolling it clear of the 48px top bar and, below lg, the 56px tab bar
    <li
      tabIndex={-1}
      className="scroll-mt-12 rounded-xl border outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-lg:scroll-mb-14"
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-t-xl border-b bg-muted px-3 py-2">
        <ActorAvatar actor={message.sender} size="xs" />
        <ActorName
          actor={message.sender}
          nameClassName="font-medium text-foreground"
        />
        {!message.expectsReply && (
          <Badge
            variant="outline"
            className="h-4.5 bg-background px-1.75 text-2xs font-normal text-muted-foreground"
          >
            Asked for no reply
          </Badge>
        )}
        <MessageTime
          iso={message.createdAt}
          className="ml-auto max-lg:hidden"
        />
      </div>
      <div className="flex flex-col gap-2 px-3 py-2.5">
        {message.replyTo && <ReplyQuote quote={message.replyTo} />}
        <Markdown>{message.text}</Markdown>
        <MessageTime iso={message.createdAt} className="lg:hidden" />
      </div>
    </li>
  );
}

// shared by the header and its skeleton, so the page doesn't shift when the pair arrives
const headerBox =
  "flex flex-col gap-2 border-b px-4 pt-3.5 pb-3 lg:gap-1.5 lg:border-0 lg:px-0 lg:pt-0";
const titleType = "text-lg leading-tight lg:text-xl";
const botRow = "flex flex-wrap items-center gap-x-3 gap-y-1.5";

function ConversationHeader({
  bots,
}: {
  bots: readonly [WebActorView, WebActorView];
}) {
  return (
    <header className={headerBox}>
      <h1 className={cn(titleType, "font-semibold")}>{pairName(bots)}</h1>
      <p className={botRow}>
        <Bot bot={bots[0]} />
        <Bot bot={bots[1]} />
      </p>
    </header>
  );
}

/** The `Messages` h1 the page has before the pair is known; the breadcrumb shows it to sight. */
const untitled = <h1 className="sr-only">Messages</h1>;

/**
 * The header's place until the pair arrives, at its height: a line at the h1's type and
 * a row of the bots' avatars.
 */
function TitleSkeleton() {
  return (
    <header data-title-skeleton className={headerBox}>
      {untitled}
      <div className={cn(titleType, "flex h-lh items-center")}>
        <SkeletonBlock className="h-4 w-2/5" />
      </div>
      <div className={botRow}>
        {["w-16", "w-20"].map((width) => (
          <span key={width} className="flex items-center gap-1.5">
            <SkeletonBlock className="size-6 rounded-md" />
            <SkeletonBlock className={width} />
          </span>
        ))}
      </div>
    </header>
  );
}

/**
 * One pair's messages, oldest first, for the person who runs trail: each with its
 * sender, time, Markdown text, the message it replies to and whether the sender asked
 * for no reply. Read-only: there is nothing to send with.
 */
export function ConversationView(props: ConversationViewProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const willLoadMore = useFocusNewPage(
    props,
    (index) => listRef.current?.children[index] as HTMLElement | undefined,
  );
  if (props.status === "not_found") return <NotFoundPanel />;
  const { bots } = props;
  let title: ReactNode;
  let body: ReactNode;
  if (props.status === "error") {
    // a failed first load can't name the pair, so the page still says what it is
    title = bots ? (
      untitled
    ) : (
      <header className={headerBox}>
        <h1 className={cn(titleType, "font-semibold")}>Conversation</h1>
      </header>
    );
    body = (
      <ErrorState
        title="Couldn't load this conversation"
        description="Check your connection, then try again."
        onRetry={props.onRetry}
      />
    );
  } else if (props.status === "loading" || !bots) {
    title = <TitleSkeleton />;
    body = <MessagesSkeleton />;
  } else if (props.messages.length === 0) {
    title = <ConversationHeader bots={bots} />;
    body = (
      <EmptyState
        icon={MessagesSquareIcon}
        title="No messages yet"
        description={`Messages between ${pairName(bots)} show up here.`}
      />
    );
  } else {
    title = <ConversationHeader bots={bots} />;
    body = (
      <>
        <ol
          ref={listRef}
          aria-label="Messages"
          className="flex flex-col gap-3 px-4 pt-3.5 lg:px-0 lg:pt-4"
        >
          {props.messages.map((message) => (
            <MessageCard key={message.id} message={message} />
          ))}
        </ol>
        {props.hasMore && (
          <LoadMore
            label="Load newer messages"
            state={props.loadMore}
            onLoadMore={props.onLoadMore}
            onRequest={willLoadMore}
          />
        )}
      </>
    );
  }
  return (
    <div className={cn(page, props.className)}>
      <div className={column}>
        {title}
        {body}
      </div>
    </div>
  );
}
