import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import { PeopleView } from "@/components/people";
import { api } from "@/lib/api";
import { statusOf } from "@/lib/loadable";
import { keys } from "@/lib/queries";
import { useAction, useKeyedAction } from "@/lib/use-action";

type RowWrite =
  | { action: "save"; username: string; projectKeys: string[] }
  | { action: "remove"; username: string };

export const Route = createFileRoute("/_app/people")({
  component: PeopleRoute,
});

// the server answers anyone else 404 too; this page never asks on their behalf
function PeopleRoute() {
  const { session } = useChrome();
  return session.viewer.isOwner ? <PeoplePage /> : <NotFoundPage />;
}

function PeoplePage() {
  const { session } = useChrome();
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: keys.people, queryFn: api.people });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.people });

  const invite = useAction(api.invite, refresh);
  const rowWrites = useKeyedAction(
    async (write: RowWrite) => {
      if (write.action === "save")
        await api.setProjects(write.username, write.projectKeys);
      else await api.remove(write.username);
    },
    (write) => write.username,
    refresh,
  );

  return (
    <AppPage section="people" heading="People">
      <PeopleView
        status={statusOf(people)}
        people={people.data?.items ?? []}
        projects={session.projects}
        onRetry={() => void people.refetch()}
        onInvite={invite.run}
        invitePending={invite.pending}
        inviteError={invite.error?.message ?? null}
        onSaveProjects={(username, projectKeys) =>
          rowWrites.run({ action: "save", username, projectKeys })
        }
        onRemove={(username) => rowWrites.run({ action: "remove", username })}
        rowMutations={rowWrites.outcomes.map(({ vars, pending, error }) => ({
          username: vars.username,
          action: vars.action,
          pending,
          error: error?.message ?? null,
        }))}
      />
    </AppPage>
  );
}
