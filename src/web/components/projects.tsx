import { FolderIcon } from "lucide-react";
import { ActorAvatar, ActorBadge } from "@/components/actor";
import { RowLink } from "@/components/app-link";
import { EmptyState, ListSkeleton, ProjectsError } from "@/components/states";
import {
  Age,
  LatestUpdate,
  TargetDate,
  UpdateHealth,
} from "@/components/status-updates";
import { KeyText } from "@/components/text";
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

/** The viewer's products in the project, keys in mono. */
function ProductKeys({ project }: { project: WebProjectView }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      {project.products.map((product) => (
        <KeyText key={product.key} className="text-foreground">
          {product.key}{" "}
        </KeyText>
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

// 16px between columns, 12px at the row's ends
const head = "h-10 px-2 text-2xs text-muted-foreground first:pl-3 last:pr-3";
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
          <TableHead className={cn(head, "w-15 text-right")}>Open</TableHead>
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
              <UpdateHealth of={project} />
            </TableCell>
            <TableCell className={cn(cell, "whitespace-normal")}>
              <ProductKeys project={project} />
            </TableCell>
            <TableCell className={cell}>
              <span className="flex min-w-0 items-center gap-2">
                <ActorAvatar actor={project.lead} size="xs" />
                <span className="truncate">{project.lead.name}</span>{" "}
                <ActorBadge kind={project.lead.kind} />
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
                badge={false}
              />
            </TableCell>
            <TableCell className={cn(cell, "text-right tabular-nums")}>
              {project.openCount}
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
    <ul className="border-t lg:hidden">
      {projects.map((project) => (
        <li
          key={project.slug}
          data-project-slug={project.slug}
          className="relative flex flex-col gap-2 border-b px-4 py-3.5"
        >
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between gap-2">
              <ProjectName project={project} />
              <UpdateHealth of={project} />
            </div>
            <p className="text-muted-foreground">{project.goal}</p>
          </div>
          <LatestUpdate
            update={project.latestStatusUpdate}
            now={now}
            layout="card"
          />
          <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            <ProductKeys project={project} />
            {project.targetDate && (
              <span>
                · Target <TargetDate date={project.targetDate} now={now} />
              </span>
            )}
            <span>· {project.openCount} open</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The projects the viewer can see a product of: a table at 1024px and up, a card each
 * below. Open counts triage and open items of the viewer's products only.
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
