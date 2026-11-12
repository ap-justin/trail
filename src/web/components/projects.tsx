import { ActorAvatar, ActorBadge } from "@/components/actor";
import { RowLink } from "@/components/app-link";
import { MarkdownText } from "@/components/markdown-text";
import {
  ListSkeleton,
  ProjectsEmpty,
  ProjectsError,
} from "@/components/states";
import { HealthPill } from "@/components/status";
import { KeyText } from "@/components/text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { WebProjectView, WebStatusUpdateView } from "@/lib/api-types";
import { paths } from "@/lib/paths";
import { formatAbsolute, formatRelative } from "@/lib/time";
import { useMinuteClock } from "@/lib/use-minute-clock";

export type ProjectsViewProps = {
  status: "loading" | "error" | "ready";
  /** The projects the viewer can see. */
  projects: WebProjectView[];
  /** Named in the empty state a person with no projects sees. */
  ownerName: string;
  isOwner: boolean;
  onRetry: () => void;
  /** The clock relative times are read against; ticks each minute when omitted. */
  now?: Date;
};

/** `41m ago`, `3h ago`; a date or `just now` stands alone. */
function age(iso: string, now: Date): string {
  const relative = formatRelative(iso, now);
  return /^\d+[mh]$/.test(relative) ? `${relative} ago` : relative;
}

function Age({
  iso,
  now,
  ago = false,
}: {
  iso: string;
  now: Date;
  ago?: boolean;
}) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {ago ? age(iso, now) : formatRelative(iso, now)}
    </time>
  );
}

/**
 * The latest update: in the table, author, badge and age over its first line; on a card,
 * two lines of it with the author under them. "No status update yet" with none.
 */
function LatestUpdate({
  update,
  now,
  layout,
}: {
  update: WebStatusUpdateView | null;
  now: Date;
  layout: "table" | "card";
}) {
  if (!update) {
    return <p className="text-muted-foreground">No status update yet</p>;
  }
  const author = (
    <div className="flex items-center gap-2">
      <ActorAvatar actor={update.author} size="xs" />
      <span className="font-medium">{update.author.name}</span>
      <ActorBadge kind={update.author.kind} />
      <span className="text-muted-foreground">
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

function ProjectName({ project }: { project: WebProjectView }) {
  return (
    <RowLink
      href={paths.project(project.key)}
      className="flex items-center gap-2"
    >
      <KeyText className="text-sm text-foreground">{project.key}</KeyText>{" "}
      <span className="font-semibold">{project.name}</span>
    </RowLink>
  );
}

function ProjectsTable({
  projects,
  now,
}: {
  projects: WebProjectView[];
  now: Date;
}) {
  return (
    <Table className="table-fixed max-lg:hidden">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-8 w-60 px-3 text-2xs text-muted-foreground">
            Project
          </TableHead>
          <TableHead className="h-8 w-24 px-3 text-2xs text-muted-foreground">
            Health
          </TableHead>
          <TableHead className="h-8 px-3 text-2xs text-muted-foreground">
            Latest status update
          </TableHead>
          <TableHead className="h-8 w-16 px-3 text-right text-2xs text-muted-foreground">
            Open
          </TableHead>
          <TableHead className="h-8 w-24 px-3 text-right text-2xs text-muted-foreground">
            In progress
          </TableHead>
          <TableHead className="h-8 w-20 px-3 text-right text-2xs text-muted-foreground">
            Updated
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {projects.map((project) => (
          <TableRow
            key={project.key}
            data-project-key={project.key}
            className="relative"
          >
            <TableCell className="px-3 py-2.5">
              <ProjectName project={project} />
              <p className="truncate text-muted-foreground">
                {project.description}
              </p>
            </TableCell>
            <TableCell className="px-3 py-2.5">
              {project.latestStatusUpdate && project.health && (
                <HealthPill health={project.health} />
              )}
            </TableCell>
            <TableCell className="px-3 py-2.5">
              <LatestUpdate
                update={project.latestStatusUpdate}
                now={now}
                layout="table"
              />
            </TableCell>
            <TableCell className="px-3 py-2.5 text-right tabular-nums">
              {project.openCount}
            </TableCell>
            <TableCell className="px-3 py-2.5 text-right tabular-nums">
              {project.inProgressCount}
            </TableCell>
            <TableCell className="px-3 py-2.5 text-right text-muted-foreground">
              <Age iso={project.updatedAt} now={now} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ProjectCards({
  projects,
  now,
}: {
  projects: WebProjectView[];
  now: Date;
}) {
  return (
    <ul className="lg:hidden">
      {projects.map((project) => (
        <li
          key={project.key}
          data-project-key={project.key}
          className="relative flex flex-col gap-1.5 border-b px-4 py-3.5"
        >
          <div className="flex items-center justify-between gap-2">
            <ProjectName project={project} />
            {project.latestStatusUpdate && project.health && (
              <HealthPill health={project.health} />
            )}
          </div>
          <LatestUpdate
            update={project.latestStatusUpdate}
            now={now}
            layout="card"
          />
          <p className="text-xs text-muted-foreground">
            {project.openCount} open · {project.inProgressCount} in progress
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every project the viewer can see: a table at 1024px and up, a card each below. Open
 * and In progress count only those two statuses; done and canceled are not counted.
 */
export function ProjectsView(props: ProjectsViewProps) {
  const now = useMinuteClock(props.now);
  if (props.status === "loading")
    return <ListSkeleton className="px-4 lg:px-6" />;
  if (props.status === "error")
    return <ProjectsError onRetry={props.onRetry} />;
  if (props.projects.length === 0) {
    return (
      <ProjectsEmpty ownerName={props.ownerName} isOwner={props.isOwner} />
    );
  }
  return (
    <div className="flex flex-col lg:px-6 lg:py-4">
      <ProjectsTable projects={props.projects} now={now} />
      <ProjectCards projects={props.projects} now={now} />
    </div>
  );
}
