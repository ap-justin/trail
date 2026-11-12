import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import {
  ProjectHeading,
  ProjectHealth,
  ProjectView,
} from "@/components/project";
import type { IssueStatus } from "@/components/status";
import { api, isNotFound } from "@/lib/api";
import { loadableOf } from "@/lib/loadable";
import { keys } from "@/lib/queries";

const statuses = {
  open: true,
  in_progress: true,
  done: true,
  canceled: true,
} satisfies Record<IssueStatus, true>;

const isStatus = (value: unknown): value is IssueStatus =>
  typeof value === "string" && Object.hasOwn(statuses, value);

export const Route = createFileRoute("/_app/projects/$key")({
  // the status filter; anything else in ?status= is All
  validateSearch: (
    search: Record<string, unknown>,
  ): { status?: IssueStatus } => ({
    status: isStatus(search.status) ? search.status : undefined,
  }),
  component: ProjectPage,
});

function ProjectPage() {
  const { key } = Route.useParams();
  const { status = null } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { session, openNewIssue } = useChrome();
  const project = useQuery({
    queryKey: keys.project(key),
    queryFn: () => api.project(key),
  });
  const issues = useQuery({
    queryKey: keys.issues(key, status),
    queryFn: () => api.issues(key, status),
  });
  const updates = useQuery({
    queryKey: keys.statusUpdates(key),
    queryFn: () => api.statusUpdates(key),
  });

  if (isNotFound(project.error)) return <NotFoundPage />;
  // named from the session's list until the project itself has loaded
  const ref = project.data ??
    session.projects.find((p) => p.key === key) ?? { key, name: "" };

  return (
    <AppPage
      section="projects"
      projectKey={key}
      heading={<ProjectHeading project={ref} />}
      headingAccessory={
        project.data && <ProjectHealth project={project.data} />
      }
    >
      <ProjectView
        project={ref}
        issues={loadableOf(issues)}
        statusUpdates={loadableOf(updates)}
        status={status}
        onStatusChange={(next) =>
          void navigate({ search: next ? { status: next } : {} })
        }
        onNewIssue={() => openNewIssue(key)}
        onRetryIssues={() => void issues.refetch()}
        onRetryStatusUpdates={() => void updates.refetch()}
      />
    </AppPage>
  );
}
