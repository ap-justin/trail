import { FolderIcon, GitPullRequestIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ActorAvatar, ActorBadge, ActorName } from "@/components/actor";
import { AppLink } from "@/components/app-link";
import { Markdown } from "@/components/markdown";
import { IssueError, IssueSkeleton, NotFoundPanel } from "@/components/states";
import {
  PriorityLabel,
  priorityLabel,
  StatusLabel,
  statusLabel,
  TypeBadge,
} from "@/components/status";
import { KeyText, LabelChip } from "@/components/text";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  EntryView,
  WebActorView,
  WebItemType,
  WebItemView,
} from "@/lib/api-types";
import type { Loadable } from "@/lib/loadable";
import { paths } from "@/lib/paths";
import { formatAbsolute, formatDay } from "@/lib/time";
import { cn } from "@/lib/utils";

export type IssueViewProps = {
  /** The key from the URL, named in the error copy before the item has loaded. */
  issueKey: string;
  /** Not found covers a missing item and one in a product the viewer can't see. */
  issue: Loadable<WebItemView> | { status: "not_found" };
  /** Who a comment will be credited to. */
  viewer: { name: string };
  onRetry: () => void;
  /** Post a comment; the box clears once `commentPending` falls with no `commentError`. */
  onComment: (body: string) => void;
  commentPending: boolean;
  /** Why the last comment didn't post, under the box; null when it did. */
  commentError: ReactNode;
};

/**
 * The shell heading on an item page, as `headingKind="breadcrumb"` (the title is the h1):
 * `Products / trail / TRL-14` at 1440, the key below.
 */
export function IssueBreadcrumb({
  issueKey,
  product,
}: {
  issueKey: string;
  /** Absent until the item has loaded. */
  product?: { key: string; name: string };
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex items-center gap-2 font-normal text-muted-foreground max-lg:hidden">
        <AppLink href={paths.products} className="hover:text-foreground">
          Products
        </AppLink>
        <span aria-hidden="true">/</span>
        {product && (
          <>
            <AppLink
              href={paths.product(product.key)}
              className="hover:text-foreground"
            >
              {product.name}
            </AppLink>
            <span aria-hidden="true">/</span>
          </>
        )}
      </span>
      <KeyText className="text-sm text-foreground">{issueKey}</KeyText>
    </span>
  );
}

function Actor({
  actor,
  titleSurface,
  withTitle = true,
}: {
  actor: WebActorView;
  titleSurface?: "card";
  /** False drops a bot's title pill, as the byline does. */
  withTitle?: boolean;
}) {
  return (
    <>
      <ActorAvatar actor={actor} size="xs" />
      <ActorName
        actor={actor}
        nameClassName="font-medium text-foreground"
        titleSurface={titleSurface}
        titleClassName={withTitle ? undefined : "hidden"}
      />{" "}
    </>
  );
}

const strong = (text: string) => (
  <span className="font-medium text-foreground">{text}</span>
);

function Header({ issue }: { issue: WebItemView }) {
  return (
    <header className="flex flex-col gap-2 border-b px-4 pt-3.5 pb-3 lg:gap-1.5 lg:border-0 lg:p-0">
      <h1 className="text-lg leading-tight font-semibold lg:text-xl">
        {issue.title}
      </h1>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <TypeBadge type={issue.type} />
        <KeyText>{issue.key}</KeyText>
        <span>{issue.type === "todo" ? "planned by" : "filed by"}</span>
        <Actor actor={issue.creator} withTitle={false} />
        <time dateTime={issue.createdAt}>
          <span className="max-lg:hidden">on </span>
          {formatDay(new Date(issue.createdAt), new Date())}
        </time>
        {issue.sourceAuthor && (
          <span className="text-2xs">originally by {issue.sourceAuthor}</span>
        )}
      </p>
    </header>
  );
}

/**
 * One label and its value; on the 1440 rail a row, in the 375 grid a cell pair.
 * `itemClassName` lands on both cells, `valueClassName` on the value alone: grid
 * placement, which the `contents` wrapper can't carry.
 */
function Property({
  label,
  children,
  className,
  itemClassName,
  valueClassName,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  itemClassName?: string;
  valueClassName?: string;
}) {
  return (
    <div className={cn("contents", className)}>
      <dt className={cn("text-muted-foreground", itemClassName)}>{label}</dt>
      <dd
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-1 lg:gap-2",
          itemClassName,
          valueClassName,
        )}
      >
        {children}
      </dd>
    </div>
  );
}

const none = <span className="text-muted-foreground">None</span>;

// an issue waits in triage for an owner; a todo always has its planning bot
const noAssignee: Record<WebItemType, ReactNode> = {
  issue: <span className="text-muted-foreground">Unassigned</span>,
  todo: none,
};

/**
 * Read-only on purpose: people never change status, priority, labels, assignee or
 * estimate, so nothing here is a control, has a hover state or carries a chevron.
 * Below lg: Status, Priority, Estimate and Product as a 4-column grid, then Labels,
 * Assignee and Projects as full rows; the byline carries the type.
 */
function Properties({ issue }: { issue: WebItemView }) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="max-lg:border-b max-lg:px-4 max-lg:py-3.5"
    >
      <h2
        id={headingId}
        className="mb-3 h-7 border-b font-medium max-lg:sr-only"
      >
        Properties
      </h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 lg:grid-cols-[--spacing(21)_minmax(0,1fr)]">
        <Property label="Type" className="max-lg:hidden">
          <TypeBadge type={issue.type} />
        </Property>
        <Property label="Status">
          <StatusLabel status={issue.status} className="text-sm" />
        </Property>
        <Property label="Priority">
          <PriorityLabel priority={issue.priority} className="text-sm" />
        </Property>
        <Property label="Estimate">
          {issue.estimate === null ? none : `${issue.estimate} h`}
        </Property>
        {/* below lg, Labels, Assignee then Projects take full-width rows after the pairs */}
        <Property
          label="Assignee"
          // at lg the label stays on the name's row, above the title's
          itemClassName="max-lg:order-2 lg:self-start"
          valueClassName="max-lg:col-span-3"
        >
          {issue.assignee ? (
            // at lg a grid with the title on a second row, indented past the avatar: the
            // name's track shrinks first so the badge's auto track keeps its width, and the
            // trailing fr track takes what's left so the avatar's auto track never stretches;
            // below, one line that wraps the pill and badge under a long name
            <span className="flex min-w-0 items-center gap-1.5 lg:grid lg:grid-cols-[auto_minmax(0,max-content)_auto_minmax(0,1fr)] lg:justify-items-start lg:gap-x-2 lg:gap-y-1">
              <ActorAvatar actor={issue.assignee} size="xs" />
              <ActorName
                actor={issue.assignee}
                className="lg:contents"
                // start-aligned, a nowrap name is as wide as its text: capped to its track
                nameClassName="max-w-full"
                // across the fr track, so the pill adds no width to the name's track
                titleClassName="lg:col-span-3 lg:col-start-2 lg:row-start-2"
              />
            </span>
          ) : (
            noAssignee[issue.type]
          )}
        </Property>
        <Property
          label="Labels"
          itemClassName="max-lg:order-1"
          valueClassName="max-lg:col-span-3"
        >
          {issue.labels.length === 0
            ? none
            : issue.labels.map((label) => (
                <LabelChip key={label} name={label} />
              ))}
        </Property>
        <Property label="Product">
          <AppLink
            href={paths.product(issue.product.key)}
            className="flex items-center gap-1 hover:underline lg:gap-2"
          >
            <KeyText className="text-foreground">{issue.product.key}</KeyText>{" "}
            {issue.product.name}
          </AppLink>
        </Property>
        <Property
          label="Projects"
          itemClassName="max-lg:order-3 self-start"
          valueClassName="max-lg:col-span-3"
        >
          {issue.projects.length === 0 ? (
            none
          ) : (
            <ul className="flex flex-col gap-1">
              {issue.projects.map((project) => (
                <li key={project.slug}>
                  <AppLink
                    href={paths.project(project.slug)}
                    className="flex items-center gap-1.5 hover:underline lg:gap-2"
                  >
                    <FolderIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    {project.name}
                  </AppLink>
                </li>
              ))}
            </ul>
          )}
        </Property>
        <Property label="Created" className="max-lg:hidden">
          {formatAbsolute(issue.createdAt)}
        </Property>
        <Property label="Updated" className="max-lg:hidden">
          {formatAbsolute(issue.updatedAt)}
        </Property>
      </dl>
    </section>
  );
}

const webScheme = /^https?:\/\//i;

function Links({ links }: { links: WebItemView["links"] }) {
  const headingId = useId();
  if (links.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="max-lg:border-b max-lg:px-4 max-lg:py-3.5 lg:mt-6"
    >
      <h2
        id={headingId}
        className="mb-1.5 font-medium lg:mb-2 lg:h-7 lg:border-b"
      >
        Links
      </h2>
      <ul>
        {links.map((link) => {
          const web = webScheme.test(link.url);
          const body = (
            <>
              <GitPullRequestIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{link.title}</span>
                <KeyText className="truncate">
                  {link.url.replace(webScheme, "")}
                </KeyText>
              </span>
            </>
          );
          const row = "flex min-h-11 items-center gap-2 py-1.5 lg:min-h-0";
          return (
            <li key={link.url}>
              {web ? (
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    row,
                    "rounded-md outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/25",
                  )}
                >
                  {body}
                </a>
              ) : (
                <span className={row}>{body}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const typeLabels: Record<WebItemType, string> = {
  issue: "Issue",
  todo: "Todo",
};

/** The words after the actor in a one-line timeline entry. */
function changePhrase(entry: EntryView): ReactNode {
  switch (entry.kind) {
    case "item_created":
      return entry.item.type === "todo"
        ? "planned this todo"
        : "filed this issue";
    case "status_changed":
      return (
        <>
          changed status from {strong(statusLabel(entry.from))} to{" "}
          <StatusLabel status={entry.to} className="text-sm font-medium" />
        </>
      );
    case "type_changed":
      return (
        <>
          changed type from {strong(typeLabels[entry.from])} to{" "}
          {strong(typeLabels[entry.to])}
        </>
      );
    case "added_to_project":
      return <>added this to project {strong(entry.project.name)}</>;
    case "removed_from_project":
      return <>removed this from project {strong(entry.project.name)}</>;
    case "priority_changed":
      return <>set priority to {strong(priorityLabel(entry.to))}</>;
    case "labels_changed":
      return (
        <>
          {entry.added.length > 0 && "added labels"}
          {entry.added.map((name) => (
            <LabelChip key={`+${name}`} name={name} />
          ))}
          {entry.removed.length > 0 && "removed labels"}
          {entry.removed.map((name) => (
            <LabelChip key={`-${name}`} name={name} />
          ))}
        </>
      );
    case "link_added":
      return <>added a link {strong(entry.link.title)}</>;
    case "assignee_changed":
      return entry.to ? (
        <>assigned this to {strong(entry.to.name)}</>
      ) : (
        "unassigned this issue"
      );
    case "estimate_changed":
      return entry.to === null ? (
        "cleared the estimate"
      ) : (
        <>set the estimate to {strong(`${entry.to} h`)}</>
      );
    // product- and project-level kinds and comments never render as a change line
    case "comment":
    case "product_status_update":
    case "product_created":
    case "product_imported":
    case "project_status_update":
    case "project_created":
    case "project_updated":
      return null;
    default:
      // typechecks only while every known kind has a case; at runtime, a kind the server added later lands here
      entry satisfies never;
      return null;
  }
}

function EntryTime({ iso, className }: { iso: string; className?: string }) {
  return (
    <time
      dateTime={iso}
      className={cn("text-xs text-muted-foreground", className)}
    >
      {formatAbsolute(iso)}
    </time>
  );
}

const dot =
  "before:absolute before:-left-6 before:size-1.75 before:rounded-full before:bg-border before:ring-2 before:ring-background max-lg:before:-left-5";

function CommentCard({
  entry,
}: {
  entry: Extract<EntryView, { kind: "comment" }>;
}) {
  return (
    <li
      data-entry-id={entry.id}
      className={cn("relative my-2 rounded-xl border before:top-4", dot)}
    >
      <div className="flex items-center gap-1.5 rounded-t-xl border-b bg-muted px-3 py-2">
        <Actor actor={entry.actor} titleSurface="card" />
        {entry.comment.sourceAuthor && (
          <span className="text-2xs text-muted-foreground">
            originally by {entry.comment.sourceAuthor}
          </span>
        )}
        <EntryTime iso={entry.createdAt} className="ml-auto max-lg:hidden" />
      </div>
      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        <Markdown>{entry.comment.body}</Markdown>
        <EntryTime iso={entry.createdAt} className="lg:hidden" />
      </div>
    </li>
  );
}

function ChangeLine({ entry }: { entry: EntryView }) {
  const phrase = changePhrase(entry);
  if (phrase === null) return null;
  return (
    <li
      data-entry-id={entry.id}
      className={cn(
        "relative flex flex-wrap items-center gap-x-1.5 gap-y-0.5 py-1.25 text-muted-foreground before:top-3",
        dot,
      )}
    >
      <Actor actor={entry.actor} />
      {phrase}
      <EntryTime
        iso={entry.createdAt}
        className="max-lg:basis-full lg:ml-auto"
      />
    </li>
  );
}

/** Oldest first: comments as cards, every other change as one line. */
function Timeline({ entries }: { entries: EntryView[] }) {
  return (
    <ol className="ml-2.25 border-l pl-4 lg:ml-2.75 lg:pl-5">
      {entries.map((entry) =>
        entry.kind === "comment" ? (
          <CommentCard key={entry.id} entry={entry} />
        ) : (
          <ChangeLine key={entry.id} entry={entry} />
        ),
      )}
    </ol>
  );
}

function CommentBox({
  viewer,
  onComment,
  pending,
  error,
}: {
  viewer: { name: string };
  onComment: (body: string) => void;
  pending: boolean;
  error: ReactNode;
}) {
  const [body, setBody] = useState("");
  const [wasPending, setWasPending] = useState(pending);
  if (pending !== wasPending) {
    setWasPending(pending);
    // the comment landed: it is in the timeline now, so the box starts over
    if (!pending && !error) setBody("");
  }
  const fieldId = useId();
  const errorId = useId();
  const empty = body.trim() === "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (empty || pending) return;
    onComment(body.trim());
  };

  return (
    <form onSubmit={submit} className="mt-3.5 flex flex-col gap-2">
      <label htmlFor={fieldId} className="sr-only">
        Comment
      </label>
      <Textarea
        id={fieldId}
        value={body}
        onChange={(event) => setBody(event.currentTarget.value)}
        placeholder="Leave a comment. Markdown works."
        aria-describedby={errorId}
        aria-invalid={error ? true : undefined}
        className="min-h-21 resize-none rounded-xl px-3 py-2.5 text-sm"
      />
      <p id={errorId} role="status" className="text-xs text-destructive">
        {error}
      </p>
      <div className="flex items-center gap-1.5">
        <p className="flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground">
          Commenting as {strong(viewer.name)}
          <ActorBadge kind="human" />
        </p>
        <Button
          type="submit"
          disabled={empty}
          aria-disabled={pending || undefined}
          aria-busy={pending || undefined}
          className="ml-auto disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 max-lg:h-10 max-lg:px-4"
        >
          {pending ? "Commenting…" : "Comment"}
        </Button>
      </div>
    </form>
  );
}

/**
 * An item (issue or todo) as people see it: everything read-only except the comment box
 * at the end of the timeline. At 1440 a main column beside a 280px Properties and Links rail; below,
 * one column in the order title, properties, links, description, activity, comment box.
 */
export function IssueView(props: IssueViewProps) {
  const { issue } = props;
  const activityId = useId();
  if (issue.status === "loading")
    return <IssueSkeleton className="px-4 py-4 lg:px-8 lg:py-6" />;
  if (issue.status === "not_found") return <NotFoundPanel />;
  if (issue.status === "error") {
    return <IssueError issueKey={props.issueKey} onRetry={props.onRetry} />;
  }
  const data = issue.data;
  return (
    <div className="flex flex-col lg:grid lg:grid-cols-[minmax(0,--spacing(190))_--spacing(70)] lg:grid-rows-[auto_auto_auto_1fr] lg:gap-x-12 lg:px-8 lg:py-6">
      <Header issue={data} />
      <aside className="lg:col-start-2 lg:row-span-4 lg:row-start-1">
        <Properties issue={data} />
        <Links links={data.links} />
      </aside>
      {data.description.trim() !== "" && (
        <Markdown className="border-b px-4 py-3.5 lg:mt-4 lg:border-0 lg:p-0">
          {data.description}
        </Markdown>
      )}
      <section
        aria-labelledby={activityId}
        className="px-4 py-3.5 lg:mt-5.5 lg:p-0"
      >
        <h2 id={activityId} className="mb-2 font-medium lg:mb-2.5">
          Activity
        </h2>
        <Timeline entries={data.timeline} />
        <CommentBox
          viewer={props.viewer}
          onComment={props.onComment}
          pending={props.commentPending}
          error={props.commentError}
        />
      </section>
    </div>
  );
}
