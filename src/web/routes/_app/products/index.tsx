import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { ProductsView } from "@/components/products";
import { api } from "@/lib/api";
import { statusOf } from "@/lib/loadable";
import { keys } from "@/lib/queries";

export const Route = createFileRoute("/_app/products/")({
  component: ProductsPage,
});

function ProductsPage() {
  const { session } = useChrome();
  const products = useQuery({ queryKey: keys.products, queryFn: api.products });
  return (
    <AppPage section="products" heading="Products">
      <ProductsView
        status={statusOf(products)}
        products={products.data?.items ?? []}
        ownerName={session.ownerName}
        isOwner={session.viewer.isOwner}
        onRetry={() => void products.refetch()}
      />
    </AppPage>
  );
}
