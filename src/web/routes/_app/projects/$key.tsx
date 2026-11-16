import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import type { StatusFilter } from "@/components/item-list";
import {
  ProductHeading,
  ProductHealth,
  ProductView,
} from "@/components/product";
import type { ItemType } from "@/components/status";
import { api, isNotFound } from "@/lib/api";
import { loadableOf } from "@/lib/loadable";
import { keys } from "@/lib/queries";

const statuses = {
  open: true,
  in_progress: true,
  done: true,
  canceled: true,
  // triage is no tab of its own: the Open tab's ?status=open matches it
} satisfies Record<StatusFilter, true>;

const isStatus = (value: unknown): value is StatusFilter =>
  typeof value === "string" && Object.hasOwn(statuses, value);

const isType = (value: unknown): value is ItemType =>
  value === "issue" || value === "todo";

export const Route = createFileRoute("/_app/projects/$key")({
  // the status and type filters; anything else in ?status= or ?type= is All
  validateSearch: (
    search: Record<string, unknown>,
  ): { status?: StatusFilter; type?: ItemType } => ({
    status: isStatus(search.status) ? search.status : undefined,
    type: isType(search.type) ? search.type : undefined,
  }),
  component: ProjectPage,
});

function ProjectPage() {
  const { key } = Route.useParams();
  const { status = null, type = null } = Route.useSearch();
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
    session.products.find((p) => p.key === key) ?? { key, name: "" };

  return (
    <AppPage
      section="products"
      productKey={key}
      heading={<ProductHeading product={ref} />}
      headingAccessory={
        project.data && <ProductHealth product={project.data} />
      }
    >
      <ProductView
        product={ref}
        detail={project.data ?? null}
        items={loadableOf(issues)}
        statusUpdates={loadableOf(updates)}
        filters={{ status, type }}
        onFiltersChange={(next) =>
          void navigate({
            search: {
              ...(next.status && { status: next.status }),
              ...(next.type && { type: next.type }),
            },
          })
        }
        onNewIssue={() => openNewIssue(key)}
        onRetryItems={() => void issues.refetch()}
        onRetryStatusUpdates={() => void updates.refetch()}
      />
    </AppPage>
  );
}
