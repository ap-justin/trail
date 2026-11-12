import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppPage } from "@/app/chrome";
import { FeedView, LiveIndicator } from "@/components/feed";
import type { FeedFilter } from "@/lib/api";
import { useLiveFeed } from "@/lib/use-live-feed";

export const Route = createFileRoute("/_app/")({
  component: FeedPage,
});

function FeedPage() {
  const [filter, setFilter] = useState<FeedFilter>({
    actor: null,
    project: null,
  });
  const feed = useLiveFeed(filter, {
    onProjectGone: () => setFilter((f) => ({ ...f, project: null })),
  });
  return (
    <AppPage
      section="feed"
      heading="Feed"
      // nothing until the stream first opens: neither Live nor Reconnecting is true yet
      headingAccessory={
        feed.connection === "open" && <LiveIndicator connection="open" />
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
        projectFilter={filter.project}
        onActorFilterChange={(actor) => setFilter((f) => ({ ...f, actor }))}
        onProjectFilterChange={(project) =>
          setFilter((f) => ({ ...f, project }))
        }
        onRetry={feed.retry}
      />
    </AppPage>
  );
}
