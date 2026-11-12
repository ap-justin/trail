import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { ProjectsView } from "@/components/projects";
import { api } from "@/lib/api";
import { statusOf } from "@/lib/loadable";
import { keys } from "@/lib/queries";

export const Route = createFileRoute("/_app/projects/")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const { session } = useChrome();
  const projects = useQuery({ queryKey: keys.projects, queryFn: api.projects });
  return (
    <AppPage section="projects" heading="Projects">
      <ProjectsView
        status={statusOf(projects)}
        projects={projects.data?.items ?? []}
        ownerName={session.ownerName}
        isOwner={session.viewer.isOwner}
        onRetry={() => void projects.refetch()}
      />
    </AppPage>
  );
}
