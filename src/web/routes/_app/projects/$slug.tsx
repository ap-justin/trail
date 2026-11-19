import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import { RowsMissing } from "@/app/rows-missing";
import {
  ProjectHeading,
  ProjectHealth,
  type ProjectItemFilters,
  ProjectView,
} from "@/components/project";
import { api, isNotFound } from "@/lib/api";
import type { WebProjectItemsView } from "@/lib/api-types";
import {
  type ItemSearch,
  itemSearchOf,
  searchText,
  validateItemSearch,
} from "@/lib/item-search";
import { loadableAfter, loadableOf } from "@/lib/loadable";
import { keys, projectItemsQuery, projectNoteCountsQuery } from "@/lib/queries";

// slugs are lowercase, so a segment with a capital and no lowercase is a product key
// from before projects: /projects/TRL was the TRL product's page
const productKey = /^(?=.*[A-Z])[A-Z0-9]{2,10}$/;

type ProjectSearch = ItemSearch & { product?: string };

// module-scoped so the query keeps its last selection, and the notes prop its identity,
// across renders
const itemsOfGroups = (list: WebProjectItemsView) =>
  list.groups.flatMap((group) => group.items);

export const Route = createFileRoute("/_app/projects/$slug")({
  validateSearch: (search: Record<string, unknown>): ProjectSearch => ({
    ...validateItemSearch(search),
    // product keys are uppercase; the server reads ?product= in any case
    product: searchText(search.product)?.toUpperCase(),
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
  const { session } = useChrome();
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
  // with ?product=, only the project's own products say whether it applies
  const itemsWaitOnProject = search.product !== undefined;
  const items = useQuery({
    ...projectItemsQuery(slug, filters),
    enabled: !itemsWaitOnProject || project.data !== undefined,
  });
  // the placeholder lends only its counts: its groups' counts follow the last tab's filters
  const shownItems = items.isPlaceholderData
    ? { data: undefined, isError: false }
    : items;
  // from the first page of whichever list under this product filter read last, so a long
  // list's later pages don't hold up the Notes section, and a tab whose read failed keeps them
  const noteCounts =
    useQuery(projectNoteCountsQuery(slug, product)).data ?? null;
  // the Notes section's, under the product filter the counts it reads follow, once they say
  // there are current notes; a list of notes has no section
  const notes = useQuery({
    ...projectItemsQuery(slug, { product, type: "note", status: "current" }),
    enabled: filters.type !== "note" && (noteCounts?.current ?? 0) > 0,
    select: itemsOfGroups,
  });
  const updates = useQuery({
    queryKey: keys.projectStatusUpdates(slug),
    queryFn: () => api.projectStatusUpdates(slug),
  });

  if (isNotFound(project.error)) {
    // an old lowercase product link, /projects/trl: only a product the viewer sees is one,
    // so a hidden product reads exactly as an unknown slug
    const key = slug.toUpperCase();
    return session.products.some((p) => p.key === key) ? (
      <Navigate
        to="/products/$key"
        params={{ key }}
        search={{ status: search.status, type: search.type }}
        replace
      />
    ) : (
      <NotFoundPage />
    );
  }
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
        items={
          itemsWaitOnProject
            ? loadableAfter(shownItems, project)
            : loadableOf(shownItems)
        }
        notes={loadableOf(notes)}
        noteCounts={noteCounts}
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
        // a refetch ignores `enabled`, so items still waiting on the project wait on its retry
        onRetryItems={() =>
          void (itemsWaitOnProject && project.data === undefined
            ? project.refetch()
            : items.refetch())
        }
        onRetryNotes={() => void notes.refetch()}
        onRetryStatusUpdates={() => void updates.refetch()}
        footer={
          <RowsMissing
            list={shownItems.data}
            shown={
              shownItems.data?.groups.reduce((n, g) => n + g.items.length, 0) ??
              0
            }
          />
        }
      />
    </AppPage>
  );
}
