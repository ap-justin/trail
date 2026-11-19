import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import { RowsMissing } from "@/app/rows-missing";
import { matchesFilters } from "@/components/item-list";
import {
  ProductHeading,
  ProductHealth,
  ProductView,
} from "@/components/product";
import { api, isNotFound } from "@/lib/api";
import { itemSearchOf, validateItemSearch } from "@/lib/item-search";
import { loadableOf } from "@/lib/loadable";
import { keys, productItemsQuery } from "@/lib/queries";

export const Route = createFileRoute("/_app/products/$key/")({
  validateSearch: validateItemSearch,
  // product keys are uppercase, and the sidebar and New issue match the URL's key exactly
  beforeLoad: ({ params, search }) => {
    const key = params.key.toUpperCase();
    if (key !== params.key) {
      throw redirect({
        to: "/products/$key",
        params: { key },
        search,
        replace: true,
      });
    }
  },
  component: ProductPage,
});

function ProductPage() {
  const { key } = Route.useParams();
  const { status = null, type = null } = Route.useSearch();
  const filters = { status, type };
  const navigate = Route.useNavigate();
  const { session, openNewIssue } = useChrome();
  const product = useQuery({
    queryKey: keys.product(key),
    queryFn: () => api.product(key),
  });
  const items = useQuery(productItemsQuery(key, filters));
  // the last filter's list stands in only while it has rows under this one: with none, the
  // view would say no matches, and its Show all would clear the filter just picked
  const shownItems =
    items.isPlaceholderData &&
    !items.data.items.some((item) => matchesFilters(item, filters))
      ? { data: undefined, isError: false }
      : items;
  // the placeholder's too: it is this product's, and its counts don't follow the filters
  const noteCounts = items.data?.counts.notes ?? null;
  // the Notes section's, once the list's counts say there are current notes; a list of
  // notes has no section
  const notes = useQuery({
    ...productItemsQuery(key, { type: "note", status: "current" }),
    enabled: type !== "note" && (noteCounts?.current ?? 0) > 0,
    select: (list) => list.items,
  });
  const updates = useQuery({
    queryKey: keys.productStatusUpdates(key),
    queryFn: () => api.productStatusUpdates(key),
  });

  if (isNotFound(product.error)) return <NotFoundPage />;
  // named from the session's list until the product itself has loaded
  const ref = product.data ??
    session.products.find((p) => p.key === key) ?? { key, name: "" };

  return (
    <AppPage
      section="products"
      productKey={key}
      heading={<ProductHeading product={ref} />}
      headingAccessory={
        product.data && <ProductHealth product={product.data} />
      }
    >
      <ProductView
        product={ref}
        detail={product.data ?? null}
        items={loadableOf(shownItems)}
        notes={loadableOf(notes)}
        noteCounts={noteCounts}
        statusUpdates={loadableOf(updates)}
        filters={filters}
        onFiltersChange={(next) =>
          void navigate({ search: itemSearchOf(next) })
        }
        onNewIssue={() => openNewIssue(key)}
        onRetryItems={() => void items.refetch()}
        onRetryNotes={() => void notes.refetch()}
        onRetryStatusUpdates={() => void updates.refetch()}
        footer={
          // the last filter's list stands in until this one loads, and its cap isn't this one's
          <RowsMissing
            list={items.isPlaceholderData ? undefined : items.data}
            shown={items.data?.items.length ?? 0}
          />
        }
      />
    </AppPage>
  );
}
