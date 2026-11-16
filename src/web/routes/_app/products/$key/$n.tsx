import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import { IssueBreadcrumb, IssueView } from "@/components/issue";
import { api, isNotFound } from "@/lib/api";
import type { WebItemView } from "@/lib/api-types";
import { loadableOf } from "@/lib/loadable";
import { itemParams, paths } from "@/lib/paths";
import { keys } from "@/lib/queries";
import { useAction } from "@/lib/use-action";

export const Route = createFileRoute("/_app/products/$key/$n")({
  // a fresh page per item: no draft, pending comment or error carries over to the next one
  remountDeps: ({ params }) => `${params.key}-${params.n}`,
  component: ItemPage,
});

function ItemPage() {
  const params = Route.useParams();
  const key = `${params.key}-${params.n}`;
  // the server would read `TRL-abc` as a source key; no item number is spelled that way
  const numbered = /^\d+$/.test(params.n);
  const { session } = useChrome();
  const queryClient = useQueryClient();
  const issue = useQuery({
    queryKey: keys.issue(key),
    queryFn: async () => {
      const item = await api.issue(key);
      // the server answers a source key or a key in another spelling with the item itself,
      // which the page then shows at its own address
      if (item.key !== key)
        queryClient.setQueryData(keys.issue(item.key), item);
      return item;
    },
    enabled: numbered,
  });
  // the key travels with the write: Query hands a pending write the latest render's options
  const comment = useAction(
    (vars: { key: string; body: string }) => api.comment(vars.key, vars.body),
    (entry, vars) => {
      queryClient.setQueryData<WebItemView>(keys.issue(vars.key), (current) =>
        current && !current.timeline.some((e) => e.id === entry.id)
          ? { ...current, timeline: [...current.timeline, entry] }
          : current,
      );
    },
  );

  if (!numbered || isNotFound(issue.error)) return <NotFoundPage />;
  if (issue.data && issue.data.key !== key) {
    return (
      <Navigate
        to="/products/$key/$n"
        params={itemParams(issue.data.key)}
        replace
      />
    );
  }
  return (
    <AppPage
      section={null}
      heading={<IssueBreadcrumb issueKey={key} product={issue.data?.product} />}
      headingKind="breadcrumb"
      productKey={issue.data?.product.key ?? params.key}
      back={
        issue.data && {
          href: paths.product(issue.data.product.key),
          label: `Back to ${issue.data.product.name}`,
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
