import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { createContext, type ReactNode, use, useEffect, useState } from "react";
import {
  AppShell,
  type AppShellProps,
  type ShellViewer,
} from "@/components/app-shell";
import { NewIssueDialog } from "@/components/new-issue-dialog";
import { SearchResults } from "@/components/search-results";
import { api } from "@/lib/api";
import type { MeView, WebProjectRefView } from "@/lib/api-types";
import { statusOf } from "@/lib/loadable";
import { isMember, keys } from "@/lib/queries";
import { useAction } from "@/lib/use-action";

export type Session = {
  viewer: ShellViewer;
  projects: WebProjectRefView[];
  ownerName: string;
};

/** The signed-in viewer `/me` describes, or null when it lets no one in. */
export function sessionOf(me: MeView): Session | null {
  if (!isMember(me) || !me.actor) return null;
  const handle = me.login === null ? me.email : `@${me.login}`;
  if (!handle) return null;
  return {
    viewer: {
      name: me.actor.name,
      handle,
      isOwner: me.state === "owner",
      photoUrl: me.actor.photoUrl,
    },
    projects: me.projects,
    ownerName: me.ownerName,
  };
}

type Chrome = {
  session: Session;
  openNewIssue: (projectKey: string | null) => void;
  signOut: () => void;
};

const ChromeContext = createContext<Chrome | null>(null);

export function useChrome(): Chrome {
  const chrome = use(ChromeContext);
  if (!chrome) throw new Error("useChrome needs the _app layout above it");
  return chrome;
}

/** What every signed-in page shares: the session, filing an issue, signing out. */
export function AppChrome({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<{ projectKey: string | null } | null>(
    null,
  );

  const create = useAction(api.createIssue, async (issue) => {
    queryClient.setQueryData(keys.issue(issue.key), issue);
    void queryClient.invalidateQueries({ queryKey: keys.projects });
    void queryClient.invalidateQueries({
      queryKey: keys.project(issue.project.key),
    });
    setDialog(null);
    await navigate({ to: "/issues/$key", params: { key: issue.key } });
  });

  const signOut = useMutation({
    mutationFn: api.signOut,
    onSuccess: async () => {
      queryClient.setQueryData<MeView>(keys.me, (me) =>
        me
          ? {
              ...me,
              state: "anonymous",
              login: null,
              email: null,
              actor: null,
              projects: [],
            }
          : me,
      );
      await router.navigate({ to: "/sign-in" });
      // nothing the last viewer could see stays cached for the next one
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    },
    // the shell has nowhere to show a failure; what /me says now decides where the viewer is
    onError: () => queryClient.invalidateQueries({ queryKey: keys.me }),
  });

  const chrome: Chrome = {
    session,
    openNewIssue: (projectKey) => {
      create.reset();
      setDialog({ projectKey });
    },
    signOut: () => signOut.mutate(),
  };

  return (
    <ChromeContext value={chrome}>
      {children}
      <NewIssueDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        projects={session.projects}
        defaultProjectKey={dialog?.projectKey ?? null}
        viewer={session.viewer}
        ownerName={session.ownerName}
        onSubmit={create.run}
        pending={create.pending}
        error={create.error?.message ?? null}
      />
    </ChromeContext>
  );
}

const SEARCH_DEBOUNCE_MS = 250;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** One signed-in page: the shell around `children`, with search, New issue and sign-out wired. */
export function AppPage({
  section,
  heading,
  headingAccessory,
  projectKey,
  back,
  children,
}: Pick<
  AppShellProps,
  | "section"
  | "heading"
  | "headingAccessory"
  | "projectKey"
  | "back"
  | "children"
>) {
  const chrome = useChrome();
  const [typed, setTyped] = useState("");
  const href = useRouterState({ select: (s) => s.location.href });
  const [searchedAt, setSearchedAt] = useState(href);
  // a page change by any other way than a result also ends the search
  if (href !== searchedAt) {
    setSearchedAt(href);
    setTyped("");
  }
  const q = useDebounced(typed.trim(), SEARCH_DEBOUNCE_MS);
  const search = useQuery({
    queryKey: keys.search(q),
    queryFn: () => api.search(q),
    enabled: q !== "",
  });

  return (
    <AppShell
      viewer={chrome.session.viewer}
      projects={chrome.session.projects}
      section={section}
      projectKey={projectKey}
      back={back}
      heading={heading}
      headingAccessory={headingAccessory}
      searchValue={typed}
      onSearch={setTyped}
      searchResults={
        typed.trim() !== "" && (
          <SearchResults
            query={typed}
            answeredQuery={q}
            results={search.data ?? null}
            status={statusOf(search)}
          />
        )
      }
      onNewIssue={() => chrome.openNewIssue(projectKey ?? null)}
      onSignOut={chrome.signOut}
    >
      {children}
    </AppShell>
  );
}
