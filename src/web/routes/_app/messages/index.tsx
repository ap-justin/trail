import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import { ConversationsView } from "@/components/messages";
import { pagingOf, statusOf } from "@/lib/loadable";
import { paths } from "@/lib/paths";
import { conversationsQuery } from "@/lib/queries";

export const Route = createFileRoute("/_app/messages/")({
  component: MessagesRoute,
});

// the server answers anyone else 404 too; this page never asks on their behalf
function MessagesRoute() {
  const { session } = useChrome();
  return session.viewer.isOwner ? <MessagesPage /> : <NotFoundPage />;
}

function MessagesPage() {
  const conversations = useInfiniteQuery(conversationsQuery);
  return (
    <AppPage section="messages" heading="Messages">
      <ConversationsView
        status={statusOf(conversations)}
        conversations={
          conversations.data?.pages.flatMap((page) => page.items) ?? []
        }
        conversationHref={({ bots }) =>
          paths.conversation(bots[0].id, bots[1].id)
        }
        onRetry={() => void conversations.refetch()}
        {...pagingOf(conversations)}
      />
    </AppPage>
  );
}
