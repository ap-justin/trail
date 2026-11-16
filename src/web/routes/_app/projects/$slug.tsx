import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppPage } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import {
  ProjectHeading,
  ProjectHealth,
  type ProjectItemFilters,
  ProjectView,
} from "@/components/project";
import { api, isNotFound } from "@/lib/api";
import {
  type ItemSearch,
  itemSearchOf,
  validateItemSearch,
} from "@/lib/item-search";
import { loadableOf } from "@/lib/loadable";
import { keys } from "@/lib/queries";

// slugs are lowercase, so a segment with a capital and no lowercase is a product key
// from before projects: /projects/TRL was the TRL product's page
const productKey = /^(?=.*[A-Z])[A-Z0-9]{2,10}$/;

type ProjectSearch = ItemSearch & { product?: string };

export const Route = createFileRoute("/_app/projects/$slug")({
  validateSearch: (search: Record<string, unknown>): ProjectSearch => ({
    ...validateItemSearch(search),
    product: typeof search.product === "string" ? search.product : undefined,
  }),
  beforeLoad: ({ params, search }) => {
    if (productKey.test(params.slug)) {
      throw redirect({
        to: "/products/$key",
        params: { key: params.slug },
        search: { status: search.status, type: search.type },
        replace: true,
      });
    }
  },
  component: ProjectPage,
});

function ProjectPage() {
  const { slug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const project = useQuery({
    queryKey: keys.project(slug),
    queryFn: () => api.project(slug),
  });
  // a product the project doesn't draw from (or the viewer can't see) is All, not a 404
  const product =
    search.product !== undefined &&
    project.data?.products.some((p) => p.key === search.product)
      ? search.product
      : null;
  const filters: ProjectItemFilters = {
    product,
    type: search.type ?? null,
    status: search.status ?? null,
  };
  const items = useQuery({
    queryKey: keys.projectItems(slug, filters),
    queryFn: () => api.projectItems(slug, filters),
    // with ?product=, only the project's own products say whether it applies
    enabled: search.product === undefined || project.data !== undefined,
  });
  const updates = useQuery({
    queryKey: keys.projectStatusUpdates(slug),
    queryFn: () => api.projectStatusUpdates(slug),
  });

  if (isNotFound(project.error)) return <NotFoundPage />;
  return (
    <AppPage
      section="projects"
      heading={<ProjectHeading project={project.data ?? { name: "" }} />}
      headingAccessory={
        project.data && <ProjectHealth project={project.data} />
      }
    >
      <ProjectView
        project={loadableOf(project)}
        items={loadableOf(items)}
        statusUpdates={loadableOf(updates)}
        filters={filters}
        onFiltersChange={(next) =>
          void navigate({
            search: {
              ...itemSearchOf(next),
              ...(next.product && { product: next.product }),
            },
          })
        }
        onRetryProject={() => void project.refetch()}
        onRetryItems={() => void items.refetch()}
        onRetryStatusUpdates={() => void updates.refetch()}
      />
    </AppPage>
  );
}
