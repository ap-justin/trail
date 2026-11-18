import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import {
  ConversationBreadcrumb,
  ConversationView,
} from "@/components/messages";
import { isNotFound } from "@/lib/api";
import { pagingOf, statusOf } from "@/lib/loadable";
import { paths } from "@/lib/paths";
import { conversationQuery } from "@/lib/queries";

export const Route = createFileRoute("/_app/messages/$a/$b")({
  // one URL, and so one cache entry, per pair: the lower id first, by code unit, as the
  // server orders a pair's bots and the conversation list links them
  beforeLoad: ({ params: { a, b } }) => {
    if (b < a) {
      throw redirect({ to: "/messages/$a/$b", params: { a: b, b: a } });
    }
  },
  component: ConversationRoute,
});

// the server answers anyone else 404 too; this page never asks on their behalf
function ConversationRoute() {
  const { session } = useChrome();
  return session.viewer.isOwner ? <ConversationPage /> : <NotFoundPage />;
}

function ConversationPage() {
  const { a, b } = Route.useParams();
  const conversation = useInfiniteQuery(conversationQuery(a, b));
  const messages = conversation.data?.pages.flatMap((page) => page.items) ?? [];
  const bots = conversation.data?.pages[0]?.bots;
  return (
    <AppPage
      section="messages"
      heading={<ConversationBreadcrumb listHref={paths.messages} bots={bots} />}
      headingKind="breadcrumb"
      back={{ href: paths.messages, label: "Back to Messages" }}
    >
      <ConversationView
        status={
          isNotFound(conversation.error) && !conversation.data
            ? "not_found"
            : statusOf(conversation)
        }
        messages={messages}
        bots={bots}
        onRetry={() => void conversation.refetch()}
        {...pagingOf(conversation)}
      />
    </AppPage>
  );
}
