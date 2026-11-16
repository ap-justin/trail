import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AppPage } from "@/app/chrome";
import { ProjectsView } from "@/components/projects";
import { statusOf } from "@/lib/loadable";
import { projectsQuery } from "@/lib/queries";

export const Route = createFileRoute("/_app/projects/")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const projects = useQuery(projectsQuery);
  return (
    <AppPage section="projects" heading="Projects">
      <ProjectsView
        status={statusOf(projects)}
        projects={projects.data ?? []}
        onRetry={() => void projects.refetch()}
      />
    </AppPage>
  );
}
