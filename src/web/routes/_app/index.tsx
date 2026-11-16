import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppPage, useChrome } from "@/app/chrome";
import { FeedView, LiveIndicator } from "@/components/feed";
import type { FeedFilter } from "@/lib/api";
import { useLiveFeed } from "@/lib/use-live-feed";

export const Route = createFileRoute("/_app/")({
  component: FeedPage,
});

function FeedPage() {
  const [filter, setFilter] = useState<FeedFilter>({
    actor: null,
    product: null,
    project: null,
    type: null,
  });
  const { session } = useChrome();
  const feed = useLiveFeed(filter, {
    onFilterGone: (gone) =>
      setFilter((f) => ({
        ...f,
        product: gone.product ? null : f.product,
        project: gone.project ? null : f.project,
      })),
  });
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
        onActorFilterChange={(actor) => setFilter((f) => ({ ...f, actor }))}
        onProductFilterChange={(product) =>
          setFilter((f) => ({ ...f, product }))
        }
        onProjectFilterChange={(project) =>
          setFilter((f) => ({ ...f, project }))
        }
        onTypeFilterChange={(type) => setFilter((f) => ({ ...f, type }))}
        onRetry={feed.retry}
        noProducts={noProducts}
      />
    </AppPage>
  );
}
