import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Navigate, redirect } from "@tanstack/react-router";
import {
  BAD_LINK,
  type EmailLink,
  NotInvitedView,
  SIGN_IN_FAILED,
  SignInView,
} from "@/components/sign-in";
import { ApiError, api } from "@/lib/api";
import { browser } from "@/lib/browser";
import { isMember, keys, meQuery } from "@/lib/queries";
import { samePath } from "../../shared/paths";

/** What a failed GitHub round trip's `?error=` code tells the viewer; better-auth's codes are its own. */
function signInFailure(code: unknown): string | undefined {
  if (typeof code !== "string" || code === "" || code === BAD_LINK) return;
  if (code === "access_denied") return "Sign-in was canceled on GitHub.";
  return SIGN_IN_FAILED;
}

const codeOf = (error: Error | null) =>
  error instanceof ApiError ? error.code : null;

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
  // a person who came in by email signs out to the sign-in page and picks a way in there
  const signOut = useMutation({
    mutationFn: api.signOut,
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.me }),
  });
  const emailLink = useMutation({
    mutationFn: (email: string) => api.emailLink(email, returnTo),
  });

  // a /me refetch can let this viewer in while the page is open; href wins over to
  if (isMember(me)) return <Navigate to="/" href={returnTo} />;
  if (me.state === "not_invited") {
    return (
      <NotInvitedView
        stranger={
          me.login === null ? { email: me.email ?? "" } : { login: me.login }
        }
        ownerName={me.ownerName}
        onSignInAgain={() =>
          me.login === null
            ? signOut.mutate()
            : signIn.mutate({ signOutFirst: true })
        }
      />
    );
  }
  const linkCode = codeOf(emailLink.error);
  return (
    <SignInView
      // still pending once it succeeded: the browser is on its way to GitHub
      pending={signIn.isPending || signIn.isSuccess}
      onSignIn={() => signIn.mutate({ signOutFirst: false })}
      error={signIn.error?.message ?? signInFailure(failed)}
      // the server can turn email off after /me said it was on
      emailSignIn={me.emailSignIn && linkCode !== "sign_in_unavailable"}
      expired={failed === BAD_LINK}
      emailLink={linkStateOf(emailLink)}
      onEmailLink={(email) => emailLink.mutate(email)}
      onUseDifferentAddress={() => emailLink.reset()}
    />
  );
}

function linkStateOf(mutation: {
  isPending: boolean;
  isSuccess: boolean;
  error: Error | null;
}): EmailLink {
  if (mutation.isPending) return { status: "sending" };
  if (mutation.isSuccess) return { status: "sent" };
  if (!mutation.error) return { status: "idle" };
  switch (codeOf(mutation.error)) {
    case "invalid_email":
      return { status: "refused" };
    case "rate_limited":
      return {
        status: "rate_limited",
        retryAfterSeconds:
          mutation.error instanceof ApiError ? mutation.error.retryAfter : null,
      };
    default:
      return { status: "failed", message: mutation.error.message };
  }
}
