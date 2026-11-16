import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import { RowsMissing } from "@/app/rows-missing";
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
        items={loadableOf(items)}
        statusUpdates={loadableOf(updates)}
        filters={filters}
        onFiltersChange={(next) =>
          void navigate({ search: itemSearchOf(next) })
        }
        onNewIssue={() => openNewIssue(key)}
        onRetryItems={() => void items.refetch()}
        onRetryStatusUpdates={() => void updates.refetch()}
        footer={
          <RowsMissing
            list={items.data}
            shown={items.data?.items.length ?? 0}
          />
        }
      />
    </AppPage>
  );
}
