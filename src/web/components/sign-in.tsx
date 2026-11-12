import type { ReactNode } from "react";
import githubMark from "@/assets/github-mark.svg?no-inline";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";

// no-inline: Vite would inline a small SVG as a data: URI, which the CSP's img-src 'self' blocks

function SignInCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="flex w-full max-w-90 flex-col">
        <Logo markClassName="h-5" wordmarkClassName="text-lg" />
        <h1 className="mt-7 mb-2 text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

const cardButton = "h-11 w-full text-sm lg:h-10";

/** `/sign-in`, signed out. */
export function SignInView({
  onSignIn,
  pending = false,
  error,
}: {
  /** Starts GitHub OAuth. */
  onSignIn: () => void;
  /** True once OAuth has started, so a second click doesn't start a second one. */
  pending?: boolean;
  /** Why the last sign-in couldn't start, such as GitHub sign-in not being set up. */
  error?: ReactNode;
}) {
  return (
    <SignInCard title="Sign in to trail">
      <p className="mb-5 text-muted-foreground">
        trail is where the bots track their work. Sign in with the GitHub
        account you were invited with.
      </p>
      {/* mounted while empty so the message is announced when it arrives */}
      <p role="status" className="text-xs text-destructive not-empty:mb-3">
        {error}
      </p>
      <Button className={cardButton} disabled={pending} onClick={onSignIn}>
        <img
          src={githubMark}
          alt=""
          data-icon="inline-start"
          className="size-4.5 dark:invert"
        />
        Continue with GitHub
      </Button>
      <p className="mt-3 text-xs text-muted-foreground">
        Only invited accounts can sign in.
      </p>
    </SignInCard>
  );
}

/** `/sign-in` after a GitHub sign-in that isn't on the list. Shows no project data. */
export function NotInvitedView({
  login,
  ownerName,
  onSignInAgain,
}: {
  /** The GitHub login that signed in, without the @. */
  login: string;
  ownerName: string;
  /** Signs out, then starts GitHub OAuth again. */
  onSignInAgain: () => void;
}) {
  return (
    <SignInCard title="You're not invited yet">
      <p className="mb-5 text-muted-foreground">
        <span className="font-mono text-xs font-medium text-foreground">
          @{login}
        </span>{" "}
        signed in with GitHub, but that account isn't on the list. Ask{" "}
        {ownerName} to invite your GitHub username, then sign in again.
      </p>
      <Button variant="outline" className={cardButton} onClick={onSignInAgain}>
        Sign in with a different account
      </Button>
    </SignInCard>
  );
}
