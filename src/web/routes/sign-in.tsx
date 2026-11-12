import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";
import { NotInvitedView, SignInView } from "@/components/sign-in";
import { api } from "@/lib/api";
import { browser } from "@/lib/browser";
import { isMember, keys, meQuery } from "@/lib/queries";

/**
 * A path on this site, or nothing. A browser reads `//`, a backslash, or a `/` after
 * stripped whitespace as the start of another host.
 */
function samePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return;
  if (value.startsWith("//") || /[\\\s]/.test(value)) return;
  return value;
}

/** What a failed GitHub round trip's `?error=` code tells the viewer; better-auth's codes are its own. */
function signInFailure(code: unknown): string | undefined {
  if (typeof code !== "string" || code === "") return;
  if (code === "access_denied") return "Sign-in was canceled on GitHub.";
  return "Something went wrong on our side. Try again.";
}

export const Route = createFileRoute("/sign-in")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { redirect?: string; error?: string } => ({
    redirect: samePath(search.redirect),
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (isMember(me)) throw redirect({ href: search.redirect ?? "/" });
  },
  component: SignIn,
});

function SignIn() {
  const { redirect: returnTo = "/", error: failed } = Route.useSearch();
  const { data: me } = useSuspenseQuery(meQuery);
  const queryClient = useQueryClient();
  const signIn = useMutation({
    mutationFn: async ({ signOutFirst }: { signOutFirst: boolean }) => {
      if (signOutFirst) {
        await api.signOut();
        // signed out now, whatever follows: a failed start then shows on the sign-in view,
        // which has the error slot the not-invited one lacks
        await queryClient.invalidateQueries({ queryKey: keys.me });
      }
      return api.signIn(returnTo);
    },
    onSuccess: ({ url }) => browser.leaveFor(url),
  });

  // a /me refetch can let this viewer in while the page is open; href wins over to
  if (isMember(me)) return <Navigate to="/" href={returnTo} />;
  if (me.state === "not_invited") {
    return (
      <NotInvitedView
        login={me.login ?? ""}
        ownerName={me.ownerName}
        onSignInAgain={() => signIn.mutate({ signOutFirst: true })}
      />
    );
  }
  return (
    <SignInView
      // still pending once it succeeded: the browser is on its way to GitHub
      pending={signIn.isPending || signIn.isSuccess}
      onSignIn={() => signIn.mutate({ signOutFirst: false })}
      error={signIn.error?.message ?? signInFailure(failed)}
    />
  );
}
