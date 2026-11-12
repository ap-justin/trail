import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import { IssueBreadcrumb, IssueView } from "@/components/issue";
import { api, isNotFound } from "@/lib/api";
import type { WebIssueView } from "@/lib/api-types";
import { loadableOf } from "@/lib/loadable";
import { paths } from "@/lib/paths";
import { keys } from "@/lib/queries";
import { useAction } from "@/lib/use-action";

export const Route = createFileRoute("/_app/issues/$key")({
  // a fresh page per issue: no draft, pending comment or error carries over to the next one
  remountDeps: ({ params }) => params.key,
  component: IssuePage,
});

function IssuePage() {
  const { key } = Route.useParams();
  const { session } = useChrome();
  const queryClient = useQueryClient();
  const issue = useQuery({
    queryKey: keys.issue(key),
    queryFn: () => api.issue(key),
  });
  // the key travels with the write: Query hands a pending write the latest render's options
  const comment = useAction(
    (vars: { key: string; body: string }) => api.comment(vars.key, vars.body),
    (entry, vars) => {
      queryClient.setQueryData<WebIssueView>(keys.issue(vars.key), (current) =>
        current && !current.timeline.some((e) => e.id === entry.id)
          ? { ...current, timeline: [...current.timeline, entry] }
          : current,
      );
    },
  );

  if (isNotFound(issue.error)) return <NotFoundPage />;
  return (
    <AppPage
      section={null}
      heading={<IssueBreadcrumb issueKey={key} project={issue.data?.project} />}
      projectKey={issue.data?.project.key}
      back={
        issue.data && {
          href: paths.project(issue.data.project.key),
          label: `Back to ${issue.data.project.name}`,
        }
      }
    >
      <IssueView
        issueKey={key}
        issue={loadableOf(issue)}
        viewer={session.viewer}
        onRetry={() => void issue.refetch()}
        onComment={(body) => comment.run({ key, body })}
        commentPending={comment.pending}
        commentError={comment.error?.message ?? null}
      />
    </AppPage>
  );
}
