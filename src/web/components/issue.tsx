import { FolderIcon, GitPullRequestIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ActorAvatar, ActorName } from "@/components/actor";
import { AppLink, textLinkFocus, textLinkTap } from "@/components/app-link";
import { Markdown } from "@/components/markdown";
import { IssueError, IssueSkeleton, NotFoundPanel } from "@/components/states";
import {
  changedStatusLabel,
  PriorityLabel,
  priorityLabel,
  StatusLabel,
  TypeIcon,
  typeLabel,
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
      <span className="flex min-w-0 items-center gap-2 font-normal text-muted-foreground max-lg:hidden">
        <AppLink
          href={paths.products}
          className={cn(textLinkFocus, "hover:text-foreground")}
        >
          Products
        </AppLink>
        <span aria-hidden="true">/</span>
        {product && (
          <>
            <AppLink
              href={paths.product(product.key)}
              className={cn(textLinkFocus, "truncate hover:text-foreground")}
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
  withTitle = true,
}: {
  actor: WebActorView;
  /** False drops a bot's title, as the byline does. */
  withTitle?: boolean;
}) {
  return (
    <>
      <ActorAvatar actor={actor} size="xs" className="lg:size-5" />
      <ActorName
        actor={actor}
        nameClassName="font-medium text-foreground"
        titleClassName={withTitle ? undefined : "hidden"}
      />{" "}
    </>
  );
}

const strong = (text: string) => (
  <span className="font-medium text-foreground">{text}</span>
);

/** The type the item was created as, which its current type loses once retyped. */
function createdAs(issue: WebItemView): WebItemType {
  const created = issue.timeline.find((e) => e.kind === "item_created");
  return created?.kind === "item_created" ? created.createdAs : issue.type;
}

/** Issue or Todo as its grey glyph and word: a fact about the item, never a chip. */
function ItemType({ type }: { type: WebItemType }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <TypeIcon type={type} decorative />
      {typeLabel(type)}
    </span>
  );
}

/**
 * At lg the title, then one byline: type, key, who filed it and when. Below lg the
 * byline dissolves into the header's flex row so type and key lead above the title,
 * with the status at their right, and the rest follows under it.
 */
function Header({ issue }: { issue: WebItemView }) {
  const lead = "max-lg:order-1";
  const rest = "max-lg:order-3";
  return (
    <header className="flex flex-wrap items-center gap-x-1.5 gap-y-2 px-4 pt-4 pb-3 text-muted-foreground lg:flex-col lg:flex-nowrap lg:items-stretch lg:gap-2 lg:p-0">
      <h1 className="basis-full text-xl leading-tight font-semibold text-foreground max-lg:order-2">
        {issue.title}
      </h1>
      <p className="max-lg:contents lg:flex lg:flex-wrap lg:items-center lg:gap-x-2 lg:gap-y-1">
        <span className={lead}>
          <ItemType type={issue.type} />
        </span>
        <KeyText className={lead}>{issue.key}</KeyText>
        <span className={rest}>
          {createdAs(issue) === "todo" ? "planned by" : "filed by"}
        </span>
        <span className={cn("flex items-center gap-1.5", rest)}>
          <Actor actor={issue.creator} withTitle={false} />
        </span>
        <time dateTime={issue.createdAt} className={rest}>
          on {formatDay(new Date(issue.createdAt), new Date())}
        </time>
        {issue.sourceAuthor && (
          <span className={cn("text-2xs", rest)}>
            originally by {issue.sourceAuthor}
          </span>
        )}
      </p>
      <StatusLabel
        status={issue.status}
        className="ml-auto text-sm lg:hidden max-lg:order-1"
      />
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
 * Below lg every property is a full 44px row; Type and Status sit in the header there
 * and Created drops, so Priority leads.
 */
function Properties({ issue }: { issue: WebItemView }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="max-lg:px-4 max-lg:py-3.5">
      <h2 id={headingId} className="mb-1 font-medium lg:mb-3">
        Properties
      </h2>
      <dl className="grid auto-rows-[minmax(--spacing(11),auto)] grid-cols-[--spacing(24)_minmax(0,1fr)] items-center gap-x-2 lg:auto-rows-auto lg:grid-cols-[--spacing(21)_minmax(0,1fr)] lg:gap-y-2">
        <Property label="Type" className="max-lg:hidden">
          <ItemType type={issue.type} />
        </Property>
        <Property label="Status" className="max-lg:hidden">
          <StatusLabel status={issue.status} className="text-sm" />
        </Property>
        <Property label="Priority">
          <PriorityLabel priority={issue.priority} className="text-sm" />
        </Property>
        <Property label="Estimate">
          {issue.estimate === null ? none : `${issue.estimate} h`}
        </Property>
        {/* at lg the label stays on the name's row, above the title's */}
        <Property label="Assignee" itemClassName="lg:self-start">
          {issue.assignee ? (
            // at lg a grid with the title on a second row, indented past the avatar;
            // below, one line that wraps the title under a long name
            <span className="flex min-w-0 items-center gap-2 lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:justify-items-start lg:gap-x-2 lg:gap-y-1">
              <ActorAvatar
                actor={issue.assignee}
                size="xs"
                className="lg:size-5"
              />
              <ActorName
                actor={issue.assignee}
                className="lg:contents"
                // start-aligned, a nowrap name is as wide as its text: capped to its track
                nameClassName="max-w-full"
                titleClassName="lg:col-start-2 lg:row-start-2"
              />
            </span>
          ) : (
            noAssignee[issue.type]
          )}
        </Property>
        <Property label="Labels">
          {issue.labels.length === 0
            ? none
            : issue.labels.map((label) => (
                <LabelChip key={label} name={label} />
              ))}
        </Property>
        <Property label="Product">
          <AppLink
            href={paths.product(issue.product.key)}
            className={cn(
              textLinkFocus,
              textLinkTap,
              "flex items-center gap-2 hover:underline",
            )}
          >
            <KeyText className="text-foreground">{issue.product.key}</KeyText>{" "}
            {issue.product.name}
          </AppLink>
        </Property>
        <Property label="Projects" itemClassName="lg:self-start">
          {issue.projects.length === 0 ? (
            none
          ) : (
            // below lg one comma-separated line, without the folder glyphs
            <ul className="flex flex-wrap gap-x-1 lg:flex-col lg:gap-1">
              {issue.projects.map((project) => (
                <li
                  key={project.slug}
                  className="flex items-center max-lg:not-last:after:content-[',']"
                >
                  <AppLink
                    href={paths.project(project.slug)}
                    className={cn(
                      textLinkFocus,
                      textLinkTap,
                      "flex items-center gap-2 hover:underline",
                    )}
                  >
                    <FolderIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground max-lg:hidden"
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
        <Property label="Updated">{formatAbsolute(issue.updatedAt)}</Property>
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
      className="max-lg:px-4 max-lg:py-3.5 lg:mt-7"
    >
      <h2 id={headingId} className="mb-1.5 font-medium lg:mb-2">
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
                    "rounded-md hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
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
      return entry.createdAs === "todo"
        ? "planned this todo"
        : "filed this issue";
    case "status_changed":
      return (
        <>
          changed status from {strong(changedStatusLabel(entry.from))} to{" "}
          <StatusLabel
            status={entry.to}
            namesTriage
            className="text-sm font-medium"
          />
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
        <>
          assigned this to{" "}
          <ActorAvatar actor={entry.to} size="xs" className="lg:size-5" />
          {strong(entry.to.name)}
        </>
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

function CommentWell({
  entry,
}: {
  entry: Extract<EntryView, { kind: "comment" }>;
}) {
  return (
    <li
      data-entry-id={entry.id}
      className="my-1.5 flex flex-col gap-1.5 rounded-lg bg-muted px-3 py-2.5"
    >
      <div className="flex items-center gap-1.5">
        <Actor actor={entry.actor} />
        {entry.comment.sourceAuthor && (
          <span className="text-2xs text-muted-foreground">
            originally by {entry.comment.sourceAuthor}
          </span>
        )}
        <EntryTime iso={entry.createdAt} className="ml-auto" />
      </div>
      {/* indented past the avatar at lg, so the body lines up with the name */}
      <Markdown className="lg:pl-7">{entry.comment.body}</Markdown>
    </li>
  );
}

function ChangeLine({ entry }: { entry: EntryView }) {
  const phrase = changePhrase(entry);
  if (phrase === null) return null;
  return (
    <li
      data-entry-id={entry.id}
      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 py-1.25 text-muted-foreground lg:min-h-8 lg:gap-x-2"
    >
      <Actor actor={entry.actor} />
      {/* below lg the time ends the actor's line and the phrase drops under the name */}
      <span className="max-lg:order-2 max-lg:flex max-lg:basis-full max-lg:flex-wrap max-lg:items-center max-lg:gap-x-1.5 max-lg:pl-6 lg:contents">
        {phrase}
      </span>
      <EntryTime iso={entry.createdAt} className="ml-auto" />
    </li>
  );
}

/** Oldest first: comments in a flat well, every other change as one line. */
function Timeline({ entries }: { entries: EntryView[] }) {
  return (
    <ol>
      {entries.map((entry) =>
        entry.kind === "comment" ? (
          <CommentWell key={entry.id} entry={entry} />
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
  const reasonId = useId();
  const empty = body.trim() === "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (empty || pending) return;
    onComment(body.trim());
  };

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col">
      <label htmlFor={fieldId} className="mb-1.5 font-medium">
        Comment
      </label>
      <Textarea
        id={fieldId}
        value={body}
        onChange={(event) => setBody(event.currentTarget.value)}
        aria-describedby={errorId}
        aria-invalid={error ? true : undefined}
        className="min-h-21 resize-none text-sm"
      />
      <p id={errorId} role="status" className="mt-1 text-xs text-destructive">
        {error}
      </p>
      {/* below lg the reason runs on in the same sentence and the button takes its own row */}
      <div className="mt-1 text-muted-foreground lg:flex lg:flex-wrap lg:items-center lg:gap-x-2.5 lg:gap-y-2">
        <p className="min-w-0 flex-1 max-lg:inline">
          Commenting as {strong(viewer.name)}. Markdown works.
        </p>{" "}
        {empty && (
          <p id={reasonId} className="max-lg:inline lg:text-xs">
            Write something to post it
          </p>
        )}
        {/* aria-disabled, not disabled: the button keeps focus and its reason stays announced */}
        <Button
          type="submit"
          aria-disabled={empty || undefined}
          aria-describedby={empty ? reasonId : undefined}
          aria-busy={pending || undefined}
          className="max-lg:mt-3 max-lg:flex max-lg:w-full"
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
 * one column in the order title, description, properties, links, activity, comment box.
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
      {data.description.trim() !== "" && (
        <Markdown className="px-4 py-3.5 lg:mt-4 lg:p-0">
          {data.description}
        </Markdown>
      )}
      <aside className="lg:col-start-2 lg:row-span-4 lg:row-start-1">
        <Properties issue={data} />
        <Links links={data.links} />
      </aside>
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
