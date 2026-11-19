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

// module-scoped so the query reruns the flatten only when the list changes, not every render;
// structural sharing keeps the notes' identity either way
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
  const productSettled = !itemsWaitOnProject || project.data !== undefined;
  const items = useQuery({
    ...projectItemsQuery(slug, filters),
    enabled: productSettled,
  });
  // the placeholder lends only its counts: its groups' counts follow the last tab's filters
  const counts = items.data?.counts ?? null;
  const shownItems = items.isPlaceholderData
    ? { data: undefined, isError: false }
    : items;
  // from the first page of whichever list under this product filter read last, so a long
  // list's later pages don't hold up the Notes section, and a tab whose read failed keeps them;
  // while a product filter's first list loads, the last filter's keep the section in place,
  // but a failed read leaves nothing coming to replace them
  const noteCountsQuery = useQuery({
    ...projectNoteCountsQuery(slug, product),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === slug ? previous : undefined,
  });
  const noteCounts =
    !productSettled || (noteCountsQuery.isPlaceholderData && items.isError)
      ? null
      : (noteCountsQuery.data ?? null);
  // the Notes section's, under the product filter the counts it reads follow, once they say
  // there are current notes; a list of notes has no section, and the last filter's counts
  // don't say this one has any
  const notes = useQuery({
    ...projectItemsQuery(slug, { product, type: "note", status: "current" }),
    enabled:
      productSettled &&
      filters.type !== "note" &&
      !noteCountsQuery.isPlaceholderData &&
      (noteCounts?.current ?? 0) > 0,
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
        counts={counts}
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
          void (productSettled ? items.refetch() : project.refetch())
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
