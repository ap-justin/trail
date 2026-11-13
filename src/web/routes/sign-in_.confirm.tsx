import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import {
  BAD_LINK,
  ConfirmSignInView,
  SIGN_IN_FAILED,
} from "@/components/sign-in";
import { ApiError, api } from "@/lib/api";
import { browser } from "@/lib/browser";
import { samePath } from "../../shared/paths";

/** Where a sign-in link lands; `sign-in_` keeps it out from under /sign-in's layout and guard. */
export const Route = createFileRoute("/sign-in_/confirm")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { token?: string; callbackURL?: string; email?: string } => ({
    token: typeof search.token === "string" ? search.token : undefined,
    callbackURL: samePath(search.callbackURL),
    email: typeof search.email === "string" ? search.email : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (!search.token) {
      throw redirect({ to: "/sign-in", search: { error: BAD_LINK } });
    }
  },
  component: ConfirmSignIn,
});

function ConfirmSignIn() {
  const { token = "", callbackURL = "/", email } = Route.useSearch();
  const navigate = useNavigate();
  const confirm = useMutation({
    mutationFn: () => api.confirmLink(token, callbackURL),
    // a full load, so the app starts over with the session the answer set
    onSuccess: ({ redirectTo }) => browser.leaveFor(redirectTo),
    onError: (error) => {
      if (error instanceof ApiError && error.code === BAD_LINK) {
        void navigate({ to: "/sign-in", search: { error: BAD_LINK } });
      }
    },
  });
  const badLink =
    confirm.error instanceof ApiError && confirm.error.code === BAD_LINK;
  return (
    <ConfirmSignInView
      email={email}
      // still pending once it succeeded: the browser is on its way
      pending={confirm.isPending || confirm.isSuccess}
      onConfirm={() => confirm.mutate()}
      error={confirm.error && !badLink ? SIGN_IN_FAILED : null}
    />
  );
}
