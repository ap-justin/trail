import { FolderIcon } from "lucide-react";
import { Fragment } from "react";
import { ActorAvatar } from "@/components/actor";
import { RowLink } from "@/components/app-link";
import { StackedBar } from "@/components/progress";
import { EmptyState, ListSkeleton, ProjectsError } from "@/components/states";
import {
  Age,
  LatestUpdate,
  NO_HEALTH,
  TargetDate,
  UpdateHealth,
} from "@/components/status-updates";
import { KeyPill } from "@/components/text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { WebProjectView } from "@/lib/api-types";
import { paths } from "@/lib/paths";
import { useMinuteClock } from "@/lib/use-minute-clock";
import { cn } from "@/lib/utils";

export type ProjectsViewProps = {
  status: "loading" | "error" | "ready";
  /** The projects drawing from a product the viewer can see, newest first. */
  projects: WebProjectView[];
  onRetry: () => void;
  /** The clock relative times are read against; ticks each minute when omitted. */
  now?: Date;
};

/** The viewer's products in the project, each key a pill. */
function ProductKeys({ project }: { project: WebProjectView }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      {project.products.map((product) => (
        <Fragment key={product.key}>
          <KeyPill>{product.key}</KeyPill>{" "}
        </Fragment>
      ))}
    </span>
  );
}

function ProjectName({ project }: { project: WebProjectView }) {
  return (
    <RowLink
      href={paths.project(project.slug)}
      className="block min-w-0 truncate font-semibold"
    >
      {project.name}
    </RowLink>
  );
}

/**
 * Nothing in scope: how many wait in triage, or No items yet. With scope empty the open
 * count is all triage; a project of only canceled items still reads No items yet.
 */
function EmptyScope({ project }: { project: WebProjectView }) {
  return (
    <span className="text-muted-foreground">
      {project.openCount > 0
        ? `${project.openCount} in triage`
        : "No items yet"}
    </span>
  );
}

const projectBar = (project: WebProjectView) => ({
  done: project.itemsDone,
  inProgress: project.itemsInProgress,
  open: project.itemsInScope - project.itemsDone - project.itemsInProgress,
});

/** The table's Progress cell: done of scope over a 96px bar. */
function ProgressCell({ project }: { project: WebProjectView }) {
  if (project.itemsInScope === 0) return <EmptyScope project={project} />;
  return (
    <>
      <p>{`${project.itemsDone} of ${project.itemsInScope}`}</p>
      <StackedBar {...projectBar(project)} className="mt-1.5 h-1.5 w-24" />
    </>
  );
}

/** The card's: a full-width bar over done of scope. */
function ProgressLine({ project }: { project: WebProjectView }) {
  if (project.itemsInScope === 0)
    return (
      <p className="text-xs">
        <EmptyScope project={project} />
      </p>
    );
  return (
    <div className="flex flex-col gap-1.5">
      <StackedBar {...projectBar(project)} className="h-1.5" />
      <p className="text-xs text-muted-foreground">
        {`${project.itemsDone} of ${project.itemsInScope} items done`}
      </p>
    </div>
  );
}

// 16px between columns, 12px at the row's ends
const head = "h-10 px-2 first:pl-3 last:pr-3";
const cell = "px-2 first:pl-3 last:pr-3";

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
          <TableHead className={cn(head, "w-65")}>Project</TableHead>
          <TableHead className={cn(head, "w-26")}>Health</TableHead>
          <TableHead className={cn(head, "w-39")}>Products</TableHead>
          <TableHead className={cn(head, "w-37")}>Lead</TableHead>
          <TableHead className={cn(head, "w-22")}>Target</TableHead>
          <TableHead className={head}>Latest status update</TableHead>
          <TableHead className={cn(head, "w-34")}>Progress</TableHead>
          <TableHead className={cn(head, "w-18 text-right")}>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {projects.map((project) => (
          <TableRow
            key={project.slug}
            data-project-slug={project.slug}
            className="relative h-17"
          >
            <TableCell className={cell}>
              <ProjectName project={project} />
              <p className="truncate text-muted-foreground">{project.goal}</p>
            </TableCell>
            <TableCell className={cell}>
              <UpdateHealth of={project} empty={NO_HEALTH} />
            </TableCell>
            <TableCell className={cn(cell, "whitespace-normal")}>
              <ProductKeys project={project} />
            </TableCell>
            <TableCell className={cell}>
              <span className="flex min-w-0 items-center gap-2">
                <ActorAvatar actor={project.lead} size="xs" />
                <span className="truncate">{project.lead.name}</span>
              </span>
            </TableCell>
            {/* a date in another year carries it and is wider than the 72px column: its year wraps under */}
            <TableCell className={cn(cell, "whitespace-normal")}>
              {project.targetDate ? (
                <TargetDate date={project.targetDate} now={now} />
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </TableCell>
            <TableCell className={cell}>
              <LatestUpdate
                update={project.latestStatusUpdate}
                now={now}
                layout="table"
              />
            </TableCell>
            <TableCell className={cell}>
              <ProgressCell project={project} />
            </TableCell>
            <TableCell className={cn(cell, "text-right text-muted-foreground")}>
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
          key={project.slug}
          data-project-slug={project.slug}
          className="relative flex flex-col gap-2 border-b border-rule px-4 py-3.5"
        >
          <div className="flex flex-col gap-0.5">
            <div className="flex items-start justify-between gap-2">
              <ProjectName project={project} />
              <span className="flex h-lh shrink-0 items-center">
                <UpdateHealth of={project} />
              </span>
            </div>
            <p className="text-muted-foreground">{project.goal}</p>
          </div>
          <LatestUpdate
            update={project.latestStatusUpdate}
            now={now}
            layout="card"
          />
          <ProgressLine project={project} />
          <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            <ProductKeys project={project} />
            {project.targetDate && (
              <span>
                · Target <TargetDate date={project.targetDate} now={now} />
              </span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The projects the viewer can see a product of: a table at 1024px and up, a card each
 * below. Progress counts the viewer's products only.
 */
export function ProjectsView(props: ProjectsViewProps) {
  const now = useMinuteClock(props.now);
  if (props.status === "loading")
    return <ListSkeleton className="px-4 lg:px-6" />;
  if (props.status === "error")
    return <ProjectsError onRetry={props.onRetry} />;
  if (props.projects.length === 0) {
    return (
      <EmptyState
        icon={FolderIcon}
        title="No projects yet"
        description="Projects that bots create show up here."
      />
    );
  }
  return (
    <div className="flex flex-col max-lg:pt-3 lg:px-6 lg:py-2">
      <ProjectsTable projects={props.projects} now={now} />
      <ProjectCards projects={props.projects} now={now} />
    </div>
  );
}
