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
import type { MeView, WebProductRefView } from "@/lib/api-types";
import { statusOf } from "@/lib/loadable";
import { itemParams } from "@/lib/paths";
import { isMember, keys } from "@/lib/queries";
import { useAction } from "@/lib/use-action";
import { useActorStream } from "@/lib/use-actor-stream";

export type Session = {
  viewer: ShellViewer;
  products: WebProductRefView[];
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
    products: me.products,
    ownerName: me.ownerName,
  };
}

type Chrome = {
  session: Session;
  openNewIssue: (productKey: string | null) => void;
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
  useActorStream();
  const [dialog, setDialog] = useState<{ productKey: string | null } | null>(
    null,
  );

  const create = useAction(api.createIssue, async (issue) => {
    queryClient.setQueryData(keys.issue(issue.key), issue);
    void queryClient.invalidateQueries({ queryKey: keys.products });
    // the product's detail, its item lists under every filter, and their counts
    void queryClient.invalidateQueries({
      queryKey: keys.product(issue.product.key),
    });
    setDialog(null);
    await navigate({ to: "/products/$key/$n", params: itemParams(issue.key) });
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
              products: [],
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
    openNewIssue: (productKey) => {
      create.reset();
      setDialog({ productKey });
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
        products={session.products}
        defaultProductKey={dialog?.productKey ?? null}
        viewer={session.viewer}
        ownerName={session.ownerName}
        onSubmit={(issue) => create.run(issue)}
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
  headingKind,
  headingAccessory,
  productKey,
  back,
  children,
}: Pick<
  AppShellProps,
  | "section"
  | "heading"
  | "headingKind"
  | "headingAccessory"
  | "productKey"
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
      products={chrome.session.products}
      section={section}
      productKey={productKey}
      back={back}
      heading={heading}
      headingKind={headingKind}
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
      onNewIssue={() => chrome.openNewIssue(productKey ?? null)}
      onSignOut={chrome.signOut}
    >
      {children}
    </AppShell>
  );
}
