import { Fragment, useId, useState } from "react";
import { ActorAvatar, ActorBadge, BotTitle } from "@/components/actor";
import { AppLink, RowLink } from "@/components/app-link";
import { Markdown } from "@/components/markdown";
import {
  EmptyState,
  ErrorState,
  IssueListEmpty,
  IssueListError,
  ListSkeleton,
  StatusFilterEmpty,
} from "@/components/states";
import {
  HealthPill,
  type IssueStatus,
  PriorityLabel,
  StatusIcon,
  StatusLabel,
  statusLabel,
} from "@/components/status";
import { KeyText, LabelChip } from "@/components/text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  WebIssueListView,
  WebIssueRowView,
  WebProjectRefView,
  WebProjectView,
  WebStatusUpdatePageView,
  WebStatusUpdateView,
} from "@/lib/api-types";
import type { Loadable } from "@/lib/loadable";
import { paths } from "@/lib/paths";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useMinuteClock } from "@/lib/use-minute-clock";
import { cn } from "@/lib/utils";

export type ProjectViewProps = {
  project: WebProjectRefView;
  /** The list under the current status filter; `counts` are per status whatever the filter. */
  issues: Loadable<WebIssueListView>;
  /** Newest first. */
  statusUpdates: Loadable<WebStatusUpdatePageView>;
  /** The status filter; null is All. The URL (`?status=`) is the route's. */
  status: IssueStatus | null;
  onStatusChange: (status: IssueStatus | null) => void;
  onNewIssue: () => void;
  onRetryIssues: () => void;
  onRetryStatusUpdates: () => void;
  /** The clock relative times are read against; ticks each minute when omitted. */
  now?: Date;
};

const filterStatuses: IssueStatus[] = [
  "open",
  "in_progress",
  "done",
  "canceled",
];
const ALL = "all";

type Counts = WebIssueListView["counts"];

/** The shell heading on a project page: `Projects / TRL trail` at 1440, `TRL trail` below. */
export function ProjectHeading({ project }: { project: WebProjectRefView }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex items-center gap-2 font-normal text-muted-foreground max-lg:hidden">
        <AppLink href={paths.projects} className="hover:text-foreground">
          Projects
        </AppLink>
        <span aria-hidden="true">/</span>
      </span>
      <KeyText className="text-sm text-foreground">{project.key}</KeyText>{" "}
      <span className="truncate">{project.name}</span>
    </span>
  );
}

/** The heading's accessory: the latest status update's health, or nothing without one. */
export function ProjectHealth({ project }: { project: WebProjectView }) {
  if (!project.latestStatusUpdate || !project.health) return null;
  return <HealthPill health={project.health} className="max-lg:ml-auto" />;
}

/** All, then each status, with its count once the list has loaded. */
function filterOptions(counts: Counts | null) {
  return [
    { value: ALL, label: "All", count: counts?.all },
    ...filterStatuses.map((status) => ({
      value: status,
      label: statusLabel(status),
      count: counts?.[status],
    })),
  ];
}

function StatusTabs({ counts }: { counts: Counts | null }) {
  const options = filterOptions(counts);
  return (
    <TabsList
      variant="line"
      aria-label="Filter by status"
      className="h-8 w-full justify-start gap-3 rounded-none border-b p-0 max-lg:hidden"
    >
      {options.map((option) => (
        <TabsTrigger
          key={option.value}
          value={option.value}
          className="h-8 flex-none px-1 font-normal text-muted-foreground data-active:text-foreground"
        >
          {option.label}{" "}
          {option.count !== undefined && (
            <span className="text-2xs text-muted-foreground">
              {option.count}
            </span>
          )}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

function StatusChips({
  value,
  counts,
  onChange,
}: {
  value: string;
  counts: Counts | null;
  onChange: (value: string) => void;
}) {
  const options = filterOptions(counts);
  // the row scrolls sideways; its right padding fades out, so a chip cut at the edge reads as more
  return (
    <ToggleGroup
      aria-label="Filter by status"
      value={[value]}
      onValueChange={(next) => {
        // pressing the current chip again empties the group; keep the filter instead
        if (next[0]) onChange(next[0]);
      }}
      className="w-full scrollbar-none overflow-x-auto px-4 py-2.5 mask-r-from-[calc(100%-var(--spacing)*4)] lg:hidden"
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          variant="outline"
          className="h-10 rounded-4xl border-border px-3 font-normal text-muted-foreground aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background"
        >
          {option.label}{" "}
          {option.count !== undefined && (
            <span className="text-2xs">{option.count}</span>
          )}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function RowTime({ iso, now }: { iso: string; now: Date }) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {formatRelative(iso, now)}
    </time>
  );
}

function Assignee({ issue }: { issue: WebIssueRowView }) {
  if (!issue.assignee) {
    return <span className="text-muted-foreground">Unassigned</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-1">
      <ActorAvatar actor={issue.assignee} size="xs" />
      <span className="truncate">{issue.assignee.name}</span>
      <ActorBadge kind={issue.assignee.kind} />
    </span>
  );
}

function Labels({ labels }: { labels: string[] }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {labels.map((label) => (
        // the space keeps the names apart when read as text; flex drops it visually
        <Fragment key={label}>
          <LabelChip name={label} />{" "}
        </Fragment>
      ))}
    </span>
  );
}

const head = "h-7.5 px-0 text-2xs text-muted-foreground";

function IssueTable({ issues, now }: { issues: WebIssueRowView[]; now: Date }) {
  return (
    <Table className="table-fixed max-lg:hidden">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={cn(head, "w-7 pl-2")}>
            <span className="sr-only">Status</span>
          </TableHead>
          <TableHead className={cn(head, "w-18")}>Key</TableHead>
          <TableHead className={head}>Title</TableHead>
          <TableHead className={cn(head, "w-20")}>Priority</TableHead>
          <TableHead className={cn(head, "w-34")}>Labels</TableHead>
          <TableHead className={cn(head, "w-36")}>Assignee</TableHead>
          <TableHead className={cn(head, "w-16 pr-2 text-right")}>
            Updated
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {issues.map((issue) => {
          const canceled = issue.status === "canceled";
          return (
            <TableRow
              key={issue.key}
              data-issue-key={issue.key}
              className="relative"
            >
              <TableCell className="py-2 pr-0 pl-2">
                <StatusIcon status={issue.status} label />
              </TableCell>
              <TableCell className="px-0 py-2">
                <KeyText>{issue.key}</KeyText>
              </TableCell>
              <TableCell className="truncate px-0 py-2 pr-3">
                <RowLink
                  href={paths.issue(issue.key)}
                  label={`${issue.key} ${issue.title}`}
                  className={cn(canceled && "text-muted-foreground")}
                >
                  {issue.title}
                </RowLink>
              </TableCell>
              <TableCell className="px-0 py-2">
                <PriorityLabel priority={issue.priority} />
              </TableCell>
              <TableCell className="px-0 py-2 whitespace-normal">
                <Labels labels={issue.labels} />
              </TableCell>
              <TableCell className="px-0 py-2">
                <Assignee issue={issue} />
              </TableCell>
              <TableCell className="py-2 pr-2 pl-0 text-right text-muted-foreground">
                <RowTime iso={issue.updatedAt} now={now} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Below 1024px: key and title over status, priority glyph, labels, assignee and age. The
 * whole row is the link, named by key and title and described by the meta line.
 */
function IssueRows({ issues, now }: { issues: WebIssueRowView[]; now: Date }) {
  const metaId = useId();
  return (
    <ul className="lg:hidden">
      {issues.map((issue) => (
        <li key={issue.key} data-issue-key={issue.key} className="border-b">
          <AppLink
            href={paths.issue(issue.key)}
            aria-label={`${issue.key} ${issue.title}`}
            aria-describedby={`${metaId}-${issue.key}`}
            className="flex min-h-16 flex-col gap-1 px-4 py-2.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:ring-inset"
          >
            <span className="flex min-w-0 items-center gap-2">
              <KeyText>{issue.key}</KeyText>
              <span
                className={cn(
                  "truncate",
                  issue.status === "canceled" && "text-muted-foreground",
                )}
              >
                {issue.title}
              </span>
            </span>
            <span
              id={`${metaId}-${issue.key}`}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <StatusLabel status={issue.status} />{" "}
              <PriorityLabel
                priority={issue.priority}
                iconOnly
                className="text-foreground"
              />{" "}
              <Labels labels={issue.labels} />{" "}
              <span className="ml-auto flex items-center gap-2">
                {issue.assignee && (
                  <>
                    <ActorAvatar actor={issue.assignee} size="xs" />
                    <span className="sr-only">
                      Assigned to {issue.assignee.name},{" "}
                      {issue.assignee.kind === "bot" ? "Bot" : "Human"}
                    </span>{" "}
                  </>
                )}
                <RowTime iso={issue.updatedAt} now={now} />
              </span>
            </span>
          </AppLink>
        </li>
      ))}
    </ul>
  );
}

function IssueListBody({
  project,
  issues,
  status,
  onStatusChange,
  onNewIssue,
  onRetryIssues,
  now,
}: Omit<ProjectViewProps, "now" | "statusUpdates" | "onRetryStatusUpdates"> & {
  now: Date;
}) {
  if (issues.status === "loading")
    return <ListSkeleton className="px-4 lg:px-2" />;
  if (issues.status === "error")
    return <IssueListError onRetry={onRetryIssues} />;
  const { items, counts } = issues.data;
  if (counts.all === 0) {
    return <IssueListEmpty projectKey={project.key} onNewIssue={onNewIssue} />;
  }
  if (items.length === 0 && status) {
    return (
      <StatusFilterEmpty
        status={status}
        onShowAll={() => onStatusChange(null)}
      />
    );
  }
  return (
    <>
      <IssueTable issues={items} now={now} />
      <IssueRows issues={items} now={now} />
    </>
  );
}

function StatusUpdateItem({ update }: { update: WebStatusUpdateView }) {
  return (
    <li className="flex flex-col gap-1 border-b py-3 last:border-b-0 max-lg:px-4 max-lg:py-3.5 max-lg:last:border-b">
      <div className="flex items-center gap-2">
        <ActorAvatar actor={update.author} size="xs" />
        <span className="font-medium">{update.author.name}</span>
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

function StatusUpdates({
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
      <EmptyState
        title="No status update yet"
        description="Bots post how the project is going here."
      />
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

type Pane = "issues" | "updates";

/**
 * A project's issues, filtered one status at a time, beside its status updates. At
 * 1024px and up the updates are a 300px rail; below, Issues and Status updates switch.
 */
export function ProjectView(props: ProjectViewProps) {
  const now = useMinuteClock(props.now);
  const [pane, setPane] = useState<Pane>("issues");
  const updatesHeading = useId();
  const counts =
    props.issues.status === "ready" ? props.issues.data.counts : null;
  const filterValue = props.status ?? ALL;
  const changeFilter = (value: string) => {
    const next = filterStatuses.find((status) => status === value) ?? null;
    if (next !== props.status) props.onStatusChange(next);
  };

  return (
    <div className="flex flex-col lg:flex-row lg:gap-8 lg:px-6 lg:py-4">
      <ToggleGroup
        aria-label="Show"
        value={[pane]}
        onValueChange={(next) => {
          if (next[0] === "issues" || next[0] === "updates") setPane(next[0]);
        }}
        spacing={5}
        className="mx-4 mt-2 w-auto rounded-none border-b lg:hidden"
      >
        {(
          [
            ["issues", "Issues"],
            ["updates", "Status updates"],
          ] as const
        ).map(([value, label]) => (
          <ToggleGroupItem
            key={value}
            value={value}
            className="-mb-px h-10 min-w-10 rounded-none border-b-2 border-transparent px-0 font-normal text-muted-foreground hover:bg-transparent aria-pressed:border-foreground aria-pressed:bg-transparent aria-pressed:text-foreground"
          >
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Tabs
        value={filterValue}
        onValueChange={(value) => changeFilter(String(value))}
        className={cn(
          "min-w-0 flex-1 gap-1",
          pane !== "issues" && "max-lg:hidden",
        )}
      >
        <StatusTabs counts={counts} />
        <StatusChips
          value={filterValue}
          counts={counts}
          onChange={changeFilter}
        />
        {/* one panel, keyed to whichever tab is current, so the list is that tab's panel */}
        <TabsContent value={filterValue}>
          <IssueListBody {...props} now={now} />
        </TabsContent>
      </Tabs>
      <section
        aria-labelledby={updatesHeading}
        className={cn(
          "lg:w-75 lg:shrink-0",
          pane !== "updates" && "max-lg:hidden",
        )}
      >
        <h2
          id={updatesHeading}
          className="flex h-8 items-center border-b font-medium max-lg:sr-only"
        >
          Status updates
        </h2>
        <StatusUpdates
          updates={props.statusUpdates}
          onRetry={props.onRetryStatusUpdates}
        />
      </section>
    </div>
  );
}
