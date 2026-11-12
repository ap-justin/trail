import { BotIcon, FolderIcon, type LucideIcon } from "lucide-react";
import {
  type ReactNode,
  type Ref,
  useEffect,
  useEffectEvent,
  useRef,
} from "react";
import { ActorAvatar, ActorBadge } from "@/components/actor";
import { RowLink } from "@/components/app-link";
import { MarkdownText } from "@/components/markdown-text";
import {
  FeedEmpty,
  FeedError,
  LoadingRegion,
  SkeletonBlock,
} from "@/components/states";
import { HealthPill, PriorityLabel, StatusLabel } from "@/components/status";
import { KeyText, LabelChip } from "@/components/text";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  EntryView,
  WebActorView,
  WebProjectRefView,
} from "@/lib/api-types";
import { paths } from "@/lib/paths";
import {
  dayKey,
  formatAbsolute,
  formatDayHeader,
  formatRelative,
} from "@/lib/time";
import { useMinuteClock } from "@/lib/use-minute-clock";
import { cn } from "@/lib/utils";

export type FeedConnection = "open" | "reconnecting";

export type FeedViewProps = {
  status: "loading" | "error" | "ready";
  /** Newest first. */
  entries: EntryView[];
  /** Entries received over SSE in the last 2 seconds; only these are highlighted. */
  freshIds: ReadonlySet<string>;
  connection: FeedConnection;
  /** Entries held back while the viewer is scrolled away from the top. */
  pendingCount: number;
  /** The "N new" pill was pressed: the list is back at the top, so merge them in. */
  onShowPending: () => void;
  /** Whether the top of the list is in view; while it isn't, hold new entries as pending. */
  onAtTopChange: (atTop: boolean) => void;
  /** Bots that acted in a visible project, and the visible projects. */
  filters: { actors: WebActorView[]; projects: WebProjectRefView[] };
  /** A bot's actor id, or null for all bots. */
  actorFilter: string | null;
  /** A project key, or null for all projects. */
  projectFilter: string | null;
  onActorFilterChange: (actorId: string | null) => void;
  onProjectFilterChange: (projectKey: string | null) => void;
  onRetry: () => void;
  /** The clock relative times are read against; ticks each minute when omitted. */
  now?: Date;
};

/** The top bar's `Live` mark while the SSE connection is open. */
export function LiveIndicator({ connection }: { connection: FeedConnection }) {
  if (connection !== "open") return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-success">
      <span aria-hidden="true" className="size-1.75 rounded-full bg-current" />
      Live
    </span>
  );
}

export function FeedView(props: FeedViewProps) {
  const now = useMinuteClock(props.now);
  const topRef = useRef<HTMLDivElement>(null);
  const reportAtTop = useEffectEvent((atTop: boolean) =>
    props.onAtTopChange(atTop),
  );

  useEffect(() => {
    const top = topRef.current;
    if (!top) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) reportAtTop(entry.isIntersecting);
    });
    observer.observe(top);
    return () => observer.disconnect();
  }, []);

  // the pill unmounts once the pending entries merge, so focus lands on the first day instead
  const firstDayRef = useRef<HTMLHeadingElement>(null);
  const focusFirstDayOnMerge = useRef(false);
  useEffect(() => {
    if (props.pendingCount > 0 || !focusFirstDayOnMerge.current) return;
    focusFirstDayOnMerge.current = false;
    firstDayRef.current?.focus();
  }, [props.pendingCount]);

  const showPending = () => {
    topRef.current?.scrollIntoView({ block: "start" });
    focusFirstDayOnMerge.current = true;
    props.onShowPending();
  };

  return (
    // the 880px column sits inside the page padding, so the padding never narrows it
    <div className="w-full lg:px-6 lg:py-4">
      <div className="mx-auto flex max-w-220 flex-col">
        <div ref={topRef} />
        <FeedFilters {...props} />
        {props.pendingCount > 0 && (
          // zero height so the pill floats over the rows instead of pushing them down
          <div className="sticky top-15 z-10 flex h-0 justify-center">
            <Button
              size="sm"
              className="rounded-4xl shadow-md max-lg:h-10"
              onClick={showPending}
            >
              {props.pendingCount} new
            </Button>
          </div>
        )}
        {props.connection === "reconnecting" && (
          <Alert className="mx-4 mt-3 w-auto border-0 bg-warning-muted py-1.5 text-xs font-medium text-warning lg:mx-0">
            <AlertDescription className="text-xs text-current">
              Reconnecting… new activity will appear when it's back.
            </AlertDescription>
          </Alert>
        )}
        <p role="status" className="sr-only">
          {newEntriesMessage(props.pendingCount || props.freshIds.size)}
        </p>
        <FeedBody {...props} now={now} firstDayRef={firstDayRef} />
      </div>
    </div>
  );
}

function newEntriesMessage(count: number) {
  if (count === 0) return "";
  return `${count} new ${count === 1 ? "entry" : "entries"}`;
}

function FeedBody({
  status,
  entries,
  freshIds,
  connection,
  onRetry,
  now,
  firstDayRef,
}: FeedViewProps & { now: Date; firstDayRef: Ref<HTMLHeadingElement> }) {
  if (status === "loading") return <FeedSkeleton />;
  if (status === "error") return <FeedError onRetry={onRetry} />;
  if (entries.length === 0) return <FeedEmpty />;
  return (
    <div className={cn(connection === "reconnecting" && "opacity-60")}>
      {groupByDay(entries).map((day, index) => (
        <section key={day.key}>
          <h2
            {...(index === 0 && { ref: firstDayRef, tabIndex: -1 })}
            className="px-4 pt-3.5 pb-1.5 text-2xs font-medium text-muted-foreground outline-none lg:px-3 lg:pt-4"
          >
            {formatDayHeader(day.iso, now)}
          </h2>
          <ul>
            {day.entries.map((entry) => (
              <FeedRow
                key={entry.id}
                entry={entry}
                fresh={freshIds.has(entry.id)}
                now={now}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function groupByDay(entries: EntryView[]) {
  const days: { key: string; iso: string; entries: EntryView[] }[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.createdAt);
    const last = days.at(-1);
    if (last?.key === key) last.entries.push(entry);
    else days.push({ key, iso: entry.createdAt, entries: [entry] });
  }
  return days;
}

function FilterSelect<T extends string>({
  label,
  allLabel,
  icon: Icon,
  options,
  value,
  onChange,
}: {
  label: string;
  allLabel: string;
  icon: LucideIcon;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (value: T | null) => void;
}) {
  const items = [{ value: null, label: allLabel }, ...options];
  return (
    <Select items={items} value={value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        // ! because the trigger's own data-[size=sm]:h-7 outranks a plain max-lg: height
        className="text-xs font-medium max-lg:h-10!"
      >
        <Icon aria-hidden="true" className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} align="start">
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value ?? ""} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function FeedFilters({
  filters,
  actorFilter,
  projectFilter,
  onActorFilterChange,
  onProjectFilterChange,
}: FeedViewProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pt-2.5 lg:px-3 lg:pt-0 lg:pb-1">
      <FilterSelect
        label="Filter by bot"
        allLabel="All bots"
        icon={BotIcon}
        options={filters.actors.map((a) => ({ value: a.id, label: a.name }))}
        value={actorFilter}
        onChange={onActorFilterChange}
      />
      <FilterSelect
        label="Filter by project"
        allLabel="All projects"
        icon={FolderIcon}
        options={filters.projects.map((p) => ({ value: p.key, label: p.name }))}
        value={projectFilter}
        onChange={onProjectFilterChange}
      />
    </div>
  );
}

function FeedSkeleton() {
  const widths = [
    ["w-7/10", "w-2/5"],
    ["w-3/5", "w-4/5"],
    ["w-3/4", "w-3/10"],
    ["w-11/20", "w-9/20"],
  ] as const;
  return (
    <LoadingRegion className="flex flex-col gap-3 px-4 pt-4 lg:px-3">
      {widths.map(([first, second]) => (
        <div key={first} className="flex items-center gap-2.5">
          <SkeletonBlock className="size-6 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <SkeletonBlock className={first} />
            <SkeletonBlock className={second} />
          </div>
        </div>
      ))}
    </LoadingRegion>
  );
}

type Sentence = {
  /** Before the subject: "changed status of". */
  verb: ReactNode;
  subject: ReactNode;
  /** The issue title (or link title) the subject names; its own line at 375. */
  title?: string;
  /** After the subject: "to In progress". */
  tail?: ReactNode;
  quote?: string;
  sourceAuthor?: string | null;
};

function issueSubject(issue: { key: string }, title: string) {
  return (
    <RowLink href={paths.issue(issue.key)} label={`${issue.key} ${title}`}>
      <KeyText>{issue.key}</KeyText>
    </RowLink>
  );
}

function projectSubject(project: WebProjectRefView) {
  return (
    <RowLink href={paths.project(project.key)} className="font-medium">
      {project.name}
    </RowLink>
  );
}

const muted = (text: string) => (
  <span className="text-muted-foreground">{text}</span>
);

function sentenceFor(entry: EntryView): Sentence {
  switch (entry.kind) {
    case "issue_created":
      return {
        verb: muted(entry.actor.kind === "bot" ? "created" : "filed"),
        subject: issueSubject(entry.issue, entry.issue.title),
        title: entry.issue.title,
        sourceAuthor: entry.sourceAuthor,
      };
    case "status_changed":
      return {
        verb: muted("changed status of"),
        subject: issueSubject(entry.issue, entry.issue.title),
        title: entry.issue.title,
        tail: (
          <>
            {muted("to")}
            <StatusLabel status={entry.to} />
          </>
        ),
      };
    case "priority_changed":
      return {
        verb: muted("changed priority of"),
        subject: issueSubject(entry.issue, entry.issue.title),
        title: entry.issue.title,
        tail: (
          <>
            {muted("to")}
            <PriorityLabel priority={entry.to} />
          </>
        ),
      };
    case "labels_changed":
      return {
        verb: muted("changed labels on"),
        subject: issueSubject(entry.issue, entry.issue.title),
        title: entry.issue.title,
        tail: (
          <>
            {entry.added.length > 0 && muted("added")}
            {entry.added.map((name) => (
              <LabelChip key={`+${name}`} name={name} />
            ))}
            {entry.removed.length > 0 && muted("removed")}
            {entry.removed.map((name) => (
              <LabelChip key={`-${name}`} name={name} />
            ))}
          </>
        ),
      };
    case "link_added":
      return {
        verb: muted("added a link to"),
        subject: issueSubject(entry.issue, entry.issue.title),
        title: entry.link.title,
      };
    case "assignee_changed":
      return entry.to
        ? {
            verb: muted("assigned"),
            subject: issueSubject(entry.issue, entry.issue.title),
            title: entry.issue.title,
            tail: (
              <>
                {muted("to")}
                <span className="font-medium">{entry.to.name}</span>
              </>
            ),
          }
        : {
            verb: muted("unassigned"),
            subject: issueSubject(entry.issue, entry.issue.title),
            title: entry.issue.title,
          };
    case "estimate_changed":
      return entry.to === null
        ? {
            verb: muted("cleared the estimate of"),
            subject: issueSubject(entry.issue, entry.issue.title),
            title: entry.issue.title,
          }
        : {
            verb: muted("changed estimate of"),
            subject: issueSubject(entry.issue, entry.issue.title),
            title: entry.issue.title,
            tail: (
              <>
                {muted("to")}
                <span>{entry.to}h</span>
              </>
            ),
          };
    case "comment":
      return {
        verb: muted("commented on"),
        subject: issueSubject(entry.issue, entry.issue.title),
        title: entry.issue.title,
        quote: entry.comment.body,
        sourceAuthor: entry.comment.sourceAuthor,
      };
    case "status_update":
      return {
        verb: (
          <span className="text-muted-foreground">
            <span className="max-lg:hidden">posted a </span>status update on
          </span>
        ),
        subject: projectSubject(entry.project),
        tail: <HealthPill health={entry.statusUpdate.health} />,
        quote: entry.statusUpdate.body,
        sourceAuthor: entry.statusUpdate.sourceAuthor,
      };
    case "project_created":
      return {
        verb: muted("created"),
        subject: projectSubject(entry.project),
      };
  }
}

function RowTime({ iso, now }: { iso: string; now: Date }) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {formatRelative(iso, now)}
    </time>
  );
}

/**
 * One feed entry. At 1440 the sentence runs on one wrapping line with the project
 * key and time at the right; below 1024 it stacks: who and when, then the verb, then
 * the title. The line wrappers turn into `display: contents` at 1440 so one DOM
 * serves both.
 */
function FeedRow({
  entry,
  fresh,
  now,
}: {
  entry: EntryView;
  fresh: boolean;
  now: Date;
}) {
  const sentence = sentenceFor(entry);
  return (
    <li
      data-entry-id={entry.id}
      className={cn(
        "relative flex items-start gap-2.5 border-b px-4 py-3 lg:px-3 lg:py-2.5",
        fresh && "row-fresh",
      )}
    >
      <ActorAvatar actor={entry.actor} className="mt-px" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 lg:flex-row lg:flex-wrap lg:items-center lg:gap-x-1.5">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 lg:contents">
          <span className="font-medium">{entry.actor.name}</span>
          <ActorBadge kind={entry.actor.kind} />
          {sentence.sourceAuthor && (
            <span className="text-2xs text-muted-foreground">
              originally by {sentence.sourceAuthor}
            </span>
          )}
          <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground lg:hidden">
            <RowTime iso={entry.createdAt} now={now} />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 lg:contents">
          {sentence.verb}
          {sentence.subject}
          {sentence.title && (
            <span aria-hidden="true" className="max-lg:hidden">
              {sentence.title}
            </span>
          )}
          {sentence.tail}
        </div>
        {sentence.title && (
          <div aria-hidden="true" className="truncate lg:hidden">
            {sentence.title}
          </div>
        )}
        {sentence.quote && (
          <p className="mt-0.5 line-clamp-2 border-l-2 pl-2 text-muted-foreground lg:mt-1 lg:basis-full">
            <MarkdownText source={sentence.quote} />
          </p>
        )}
      </div>
      <KeyText className="max-lg:hidden">{entry.project.key}</KeyText>
      <span className="w-14 text-right text-xs whitespace-nowrap text-muted-foreground max-lg:hidden">
        <RowTime iso={entry.createdAt} now={now} />
      </span>
    </li>
  );
}
