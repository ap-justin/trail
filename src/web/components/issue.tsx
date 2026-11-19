import {
  ChevronDownIcon,
  ChevronUpIcon,
  FolderIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ActorAvatar, ActorName } from "@/components/actor";
import { AppLink, textLinkFocus, textLinkTap } from "@/components/app-link";
import { Markdown } from "@/components/markdown";
import { IssueError, IssueSkeleton, NotFoundPanel } from "@/components/states";
import {
  changedStatusLabel,
  PriorityLabel,
  priorityLabel,
  StatusIcon,
  StatusLabel,
  TypeIcon,
  typeLabel,
} from "@/components/status";
import { KeyPill, KeyText, LabelChip } from "@/components/text";
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
 * `Products / trail / TRL-14` from xl, `trail / TRL-14` at lg, the key below. In a
 * narrow bar column the product name truncates and the key never does.
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
          className={cn(textLinkFocus, "hover:text-foreground max-xl:hidden")}
        >
          Products
        </AppLink>
        <span aria-hidden="true" className="max-xl:hidden">
          /
        </span>
        {product && (
          <>
            <AppLink
              href={paths.product(product.key)}
              className={cn(
                textLinkFocus,
                "min-w-0 truncate hover:text-foreground",
              )}
            >
              {product.name}
            </AppLink>
            <span aria-hidden="true">/</span>
          </>
        )}
      </span>
      <KeyText className="shrink-0 text-sm text-foreground">{issueKey}</KeyText>
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

/** Issue, Todo or Note as its grey glyph and word: a fact about the item, never a chip. */
function ItemType({ type }: { type: WebItemType }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <TypeIcon type={type} decorative />
      {typeLabel(type)}
    </span>
  );
}

const createdBy: Record<WebItemType, string> = {
  issue: "filed by",
  todo: "planned by",
  note: "written by",
};

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
        <span className={rest}>{createdBy[createdAs(issue)]}</span>
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
const noAssignee: Record<Exclude<WebItemType, "note">, ReactNode> = {
  issue: <span className="text-muted-foreground">Unassigned</span>,
  todo: none,
};

/**
 * Read-only on purpose: people never change status, priority, labels, assignee or
 * estimate, so nothing here is a control, has a hover state or carries a chevron. A note
 * is never assigned, prioritised or estimated, so it has no Assignee, Priority or Estimate row.
 * Below lg every property is a full 44px row; Type and Status sit in the header there
 * and Created drops, so Priority leads (Labels on a note).
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
        {issue.type !== "note" && (
          <>
            <Property label="Priority">
              <PriorityLabel priority={issue.priority} className="text-sm" />
            </Property>
            <Property label="Estimate">
              {issue.estimate === null ? none : `${issue.estimate} h`}
            </Property>
          </>
        )}
        {/* at lg the label stays on the name's row, above the title's */}
        {issue.type !== "note" && (
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
        )}
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
              "flex min-w-0 items-center gap-2 hover:underline",
            )}
          >
            <span className="truncate">{issue.product.name}</span>{" "}
            <KeyPill>{issue.product.key}</KeyPill>
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

/**
 * Items as links, each its status and type glyphs, key and title: the items a note is about, or the
 * notes about this item, with `children` under them. Nothing when there are no items and no `children`.
 * With `currentNotes` every row is a current note under its heading, so the status glyph goes and the
 * note glyph stays unnamed: each link is its key and title.
 */
function ItemRefs({
  heading,
  items,
  currentNotes = false,
  children,
}: {
  heading: string;
  items: WebItemView["about"];
  currentNotes?: boolean;
  children?: ReactNode;
}) {
  const headingId = useId();
  if (items.length === 0 && children === undefined) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="max-lg:px-4 max-lg:py-3.5 lg:mt-7"
    >
      <h2 id={headingId} className="mb-1.5 font-medium lg:mb-2">
        {heading}
      </h2>
      {items.length > 0 && (
        <ul>
          {items.map((item) => (
            <li key={item.key}>
              <AppLink
                href={paths.issue(item.key)}
                className="group flex min-h-11 items-center gap-2 rounded-md py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:min-h-0"
              >
                {/* named by its glyphs and words: "In progress Issue TRL-14 Team access" */}
                {!currentNotes && (
                  <>
                    <StatusIcon status={item.status} label />{" "}
                  </>
                )}
                <TypeIcon type={item.type} decorative={currentNotes} />{" "}
                <KeyText className="shrink-0">{item.key}</KeyText>{" "}
                <span className="min-w-0 truncate group-hover:underline">
                  {item.title}
                </span>
              </AppLink>
            </li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}

/**
 * The notes about an item: the current ones the read carries (newest first, capped), then
 * what the list leaves out as one plain sentence. The web list has no about filter, so the
 * counts link nowhere, and a sentence keeps them from reading as the product page's button.
 */
function NotesAbout({ item }: { item: WebItemView }) {
  const { current, archived } = item.notesCount;
  if (current + archived === 0) return null;
  const left = notesLeftOut(current, current - item.notes.length, archived);
  return (
    <ItemRefs heading="Notes" items={item.notes} currentNotes>
      {left && <p className="py-1.5 text-muted-foreground">{left}</p>}
    </ItemRefs>
  );
}

const notesWord = (n: number) => (n === 1 ? "note" : "notes");

/** "No current notes, 2 archived." · "3 more current notes, 1 archived." · "1 archived note." */
function notesLeftOut(current: number, unlisted: number, archived: number) {
  const lead =
    current === 0
      ? "No current notes"
      : unlisted > 0
        ? `${unlisted} more current ${notesWord(unlisted)}`
        : null;
  if (archived === 0) return lead && `${lead}.`;
  return lead
    ? `${lead}, ${archived} archived.`
    : `${archived} archived ${notesWord(archived)}.`;
}

const webScheme = /^https?:\/\//i;

type ItemLink = WebItemView["links"][number];
type PullRequestState = NonNullable<ItemLink["pr"]>["state"] | "unknown";

// the server's matcher in src/server/github/pull-requests.ts, kept apart so no server code ships
const pullRequestUrl =
  /^https:\/\/github\.com\/[a-z0-9-]+\/(?!\.+\/)[a-z0-9._-]+\/pull\/[1-9]\d*(?:[/?#].*)?$/is;

/** A pull request link's state; null for any other link. */
function pullRequestState(link: ItemLink): PullRequestState | null {
  if (link.pr) return link.pr.state;
  // null: trail has not read it yet; absent on a pull request url: the server sent none
  if (link.pr === null || pullRequestUrl.test(link.url)) return "unknown";
  return null;
}

/** Glyph and word share one ink, so the state never rests on colour alone. */
const pullRequestStates: Record<
  PullRequestState,
  { Glyph: typeof GitPullRequestIcon; word: string; ink: string }
> = {
  open: {
    Glyph: GitPullRequestIcon,
    word: "Open",
    ink: "font-medium text-foreground",
  },
  draft: {
    Glyph: GitPullRequestDraftIcon,
    word: "Draft",
    ink: "font-medium text-muted-foreground",
  },
  merged: {
    Glyph: GitMergeIcon,
    word: "Merged",
    ink: "font-medium text-success",
  },
  closed: {
    Glyph: GitPullRequestClosedIcon,
    word: "Closed",
    ink: "font-medium text-destructive",
  },
  unknown: {
    Glyph: GitPullRequestIcon,
    word: "State unknown",
    ink: "text-muted-foreground",
  },
};

/**
 * A pull request link: the state line, the title (wrapping), the URL. The `{" "}`s render
 * nothing between flex items but keep the words apart in the link's accessible name.
 */
function PullRequestBody({
  link,
  state,
}: {
  link: ItemLink;
  state: PullRequestState;
}) {
  const { Glyph, word, ink } = pullRequestStates[state];
  return (
    <>
      <Glyph aria-hidden="true" className={cn("size-4 shrink-0", ink)} />
      <span className="flex min-w-0 flex-col">
        <span className={cn("text-xs leading-4", ink)}>
          <span className="sr-only">Pull request</span> {word}
        </span>{" "}
        <span className="mt-px group-hover:underline">{link.title}</span>{" "}
        <KeyText className="truncate">
          {link.url.replace(webScheme, "")}
        </KeyText>
      </span>
    </>
  );
}

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
          const state = pullRequestState(link);
          const body = state ? (
            <PullRequestBody link={link} state={state} />
          ) : (
            <>
              <GitPullRequestIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate group-hover:underline">
                  {link.title}
                </span>
                <KeyText className="truncate">
                  {link.url.replace(webScheme, "")}
                </KeyText>
              </span>
            </>
          );
          // a pull request's glyph sits on its 16px state line, above the title and URL
          const row = state
            ? "grid grid-cols-[--spacing(4)_minmax(0,1fr)] gap-x-2 py-1.5 max-lg:min-h-11"
            : "flex min-h-11 items-center gap-2 py-1.5 lg:min-h-0";
          return (
            <li key={link.url}>
              {web ? (
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    row,
                    "group rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
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

const createdPhrase: Record<WebItemType, string> = {
  issue: "filed this issue",
  todo: "planned this todo",
  note: "wrote this note",
};

/** The words after the actor in a one-line timeline entry. */
function changePhrase(entry: EntryView): ReactNode {
  switch (entry.kind) {
    case "item_created":
      return createdPhrase[entry.createdAs];
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
          changed type from {strong(typeLabel(entry.from))} to{" "}
          {strong(typeLabel(entry.to))}
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

/**
 * How many whole lines tall `ref`'s element renders, in its own line height; null until
 * measured. Re-measured whenever the element resizes (a narrower column, a font landing).
 */
function useRenderedLines(ref: RefObject<HTMLElement | null>): number | null {
  const [lines, setLines] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(element).lineHeight,
      );
      // half a pixel absorbs subpixel rounding, so exactly n lines never reads as n - 1
      const height = element.getBoundingClientRect().height + 0.5;
      setLines(Math.floor(height / lineHeight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return lines;
}

/** Past this many lines a comment collapses to 4 (`max-h-[4lh]`), so a collapse hides 2 or more. */
const fullLines = 5;

function CommentWell({
  entry,
}: {
  entry: Extract<EntryView, { kind: "comment" }>;
}) {
  const bodyId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const lines = useRenderedLines(contentRef);
  const [open, setOpen] = useState(false);
  // focus moving into a collapsed body with no press behind it opens it: Tab onto a link the clamp
  // hides. Chrome and Firefox focus a link on mousedown (on touch, the compat mousedown after
  // pointerup, so pointer events can't tell), so a focus whose target holds the pressed node came
  // from a press and opens nothing. A node, not a flag: a text drag released outside the body never
  // sends the mouseup that clears it
  const pressed = useRef<EventTarget | null>(null);
  // coming back to the window (from the tab a link opened) re-focuses the element that had focus,
  // which is no Tab either; the element that lost focus along with the window is remembered so its
  // focus on return opens nothing
  const leftWithWindow = useRef<EventTarget | null>(null);
  // the document listener that ends the remembering; one at a time, and gone with the comment
  const windowReturn = useRef<AbortController | null>(null);
  useEffect(() => () => windowReturn.current?.abort(), []);
  // the body shrinks above the button on Show less; where scroll anchoring doesn't hold it,
  // the button would end up above the viewport with focus still on it
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (wasOpen.current && !open) {
      buttonRef.current?.scrollIntoView({ block: "nearest" });
    }
    wasOpen.current = open;
  }, [open]);
  const long = lines !== null && lines > fullLines;
  const action = open ? "Show less" : "Show more";
  const Chevron = open ? ChevronUpIcon : ChevronDownIcon;
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
      <div>
        {/* indented past the avatar at lg, so the body lines up with the name; collapsed,
            4 lines with the last one fading out (no motion: the height swaps instantly) */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: not a control; it opens the body when focus moves in without a press (Tab onto a link the clamp hides), and its mouse and blur handlers only note which node was pressed or left with the window so a clicked link stays put */}
        <div
          id={bodyId}
          className={cn(
            "lg:pl-7",
            long &&
              !open &&
              // hidden, not clip: find-in-page scrolls a hidden box to show a match; a clip box can't scroll
              "max-h-[4lh] overflow-hidden mask-b-from-[calc(100%-1lh)]",
          )}
          onMouseDown={(e) => {
            pressed.current = e.target;
          }}
          onMouseUp={() => {
            pressed.current = null;
          }}
          onBlur={(e) => {
            if (document.hasFocus()) {
              leftWithWindow.current = null;
              return;
            }
            const left = e.target;
            leftWithWindow.current = left;
            // only the first focus after the window comes back can be the return; focus landing
            // anywhere else (a click elsewhere, Tab in from the address bar) ends the remembering,
            // so a later Tab onto this element opens. Capture runs before React's root listener
            windowReturn.current?.abort();
            windowReturn.current = new AbortController();
            document.addEventListener(
              "focusin",
              (next) => {
                if (next.target !== left) leftWithWindow.current = null;
              },
              {
                capture: true,
                once: true,
                signal: windowReturn.current.signal,
              },
            );
          }}
          onFocus={(e) => {
            const returning = leftWithWindow.current === e.target;
            leftWithWindow.current = null;
            if (returning || !long) return;
            const target = pressed.current;
            if (target instanceof Node && e.target.contains(target)) {
              return;
            }
            setOpen(true);
          }}
        >
          {/* measured unclamped, so opening and closing never changes the count */}
          <div ref={contentRef}>
            <Markdown>{entry.comment.body}</Markdown>
          </div>
        </div>
        {long && (
          <button
            ref={buttonRef}
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={`${action} of the comment by ${entry.actor.name}`}
            onClick={() => setOpen(!open)}
            className="inline-flex h-11 items-center gap-1 rounded-sm pr-1 font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-lg:-mb-1.5 max-lg:focus-visible:-outline-offset-2 lg:mt-0.5 lg:ml-7 lg:h-7 lg:px-1 lg:focus-visible:outline-offset-2"
          >
            {action}
            <Chevron aria-hidden="true" className="size-3.5" />
          </button>
        )}
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
 * An item (issue, todo or note) as people see it: everything read-only except the comment box
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
        <ItemRefs heading="About" items={data.about} />
        <NotesAbout item={data} />
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
