import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AppPage, useChrome } from "@/app/chrome";
import { NotFoundPage } from "@/app/not-found-page";
import { PeopleView } from "@/components/people";
import { api } from "@/lib/api";
import { statusOf } from "@/lib/loadable";
import { keys } from "@/lib/queries";
import { useAction } from "@/lib/use-action";

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
  const save = useAction(
    ({ username, projectKeys }: { username: string; projectKeys: string[] }) =>
      api.setProjects(username, projectKeys),
    refresh,
  );
  const remove = useAction(api.remove, refresh);
  // one row control reports at a time: whichever write that row ran last
  const rowWrite = [
    save.vars && { ...save, username: save.vars.username },
    remove.vars && { ...remove, username: remove.vars },
  ].find((write) => write && (write.pending || write.error));

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
        onSaveProjects={(username, projectKeys) => {
          remove.reset();
          save.run({ username, projectKeys });
        }}
        onRemove={(username) => {
          save.reset();
          remove.run(username);
        }}
        rowMutation={
          rowWrite
            ? {
                username: rowWrite.username,
                pending: rowWrite.pending,
                error: rowWrite.error?.message ?? null,
              }
            : null
        }
      />
    </AppPage>
  );
}
