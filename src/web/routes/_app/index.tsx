import { type UseQueryResult, useQueries } from "@tanstack/react-query";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { FeedView, LiveIndicator } from "@/components/feed";
import { workingNowEntries } from "@/components/working-now";
import type { FeedFilter } from "@/lib/api";
import type { WebItemListView, WebProductRefView } from "@/lib/api-types";
import { type FeedSearch, validateFeedSearch } from "@/lib/item-search";
import { IN_PROGRESS, productItemsQuery } from "@/lib/queries";
import { useLiveFeed } from "@/lib/use-live-feed";

export const Route = createFileRoute("/_app/")({
  validateSearch: validateFeedSearch,
  component: FeedPage,
});

// module-level, so useQueries reruns it only when a read changes, not on every render
const combineWorkingNow = (reads: UseQueryResult<WebItemListView>[]) =>
  workingNowEntries(reads.flatMap((read) => read.data?.items ?? []));

/**
 * Bots at work across `products`: each product's in-progress items, read on their own,
 * so a product whose read failed or hasn't answered only leaves its bots out.
 */
function useWorkingNow(products: WebProductRefView[]) {
  return useQueries({
    queries: products.map((product) => ({
      ...productItemsQuery(product.key, IN_PROGRESS),
      // the feed's stream re-reads a product as its bot work moves, filtered or not; a mount
      // still reads, since no stream ran while the viewer was off the feed
      refetchOnWindowFocus: false,
    })),
    combine: combineWorkingNow,
  });
}

function FeedPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const filter: FeedFilter = {
    actor: search.actor ?? null,
    product: search.product ?? null,
    project: search.project ?? null,
    type: search.type ?? null,
  };
  // replace: a filter is a view of this page, so Back leaves the feed rather than stepping through them
  const setSearch = (change: (prev: FeedSearch) => FeedSearch) =>
    void navigate({ search: change, replace: true });
  const router = useRouter();
  const { session } = useChrome();
  const feed = useLiveFeed(filter, {
    onFilterGone: (gone) => {
      // a check that answers once the viewer has moved on would replace their new page with the feed
      if (router.latestLocation.pathname !== Route.fullPath) return;
      setSearch((prev) => ({
        ...prev,
        actor: prev.actor === gone.actor ? undefined : prev.actor,
        product: prev.product === gone.product ? undefined : prev.product,
        project: prev.project === gone.project ? undefined : prev.project,
      }));
    },
  });
  const workingNow = useWorkingNow(session.products);
  const noProducts = !session.viewer.isOwner && session.products.length === 0;
  return (
    <AppPage
      section="feed"
      heading="Feed"
      // nothing until the stream first opens: neither Live nor Reconnecting is true yet;
      // nor while a member with no products has no rows, which hides the filters too;
      // the stream checks access per event, so a product granted mid-view starts delivering
      headingAccessory={
        feed.connection === "open" &&
        !(noProducts && feed.entries.length === 0) && (
          <LiveIndicator connection="open" />
        )
      }
    >
      <FeedView
        status={feed.status}
        entries={feed.entries}
        freshIds={feed.freshIds}
        connection={
          feed.connection === "reconnecting" ? "reconnecting" : "open"
        }
        pendingCount={feed.pendingCount}
        onShowPending={feed.showPending}
        onAtTopChange={feed.setAtTop}
        filters={feed.filters}
        actorFilter={filter.actor}
        productFilter={filter.product}
        projectFilter={filter.project}
        typeFilter={filter.type}
        onActorFilterChange={(actor) =>
          setSearch((prev) => ({ ...prev, actor: actor ?? undefined }))
        }
        onProductFilterChange={(product) =>
          setSearch((prev) => ({ ...prev, product: product ?? undefined }))
        }
        onProjectFilterChange={(project) =>
          setSearch((prev) => ({ ...prev, project: project ?? undefined }))
        }
        onTypeFilterChange={(type) =>
          setSearch((prev) => ({ ...prev, type: type ?? undefined }))
        }
        onRetry={feed.retry}
        noProducts={noProducts}
        workingNow={workingNow}
      />
    </AppPage>
  );
}
