import { MailIcon } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
// no-inline: Vite would inline a small SVG as a data: URI, which the CSP's img-src 'self' blocks
import githubMark from "@/assets/github-mark.svg?no-inline";
import { Logo } from "@/components/logo";
import { KeyText } from "@/components/text";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { parseInvitee } from "../../shared/invitee";

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

/** Where asking for a sign-in link stands. */
export type EmailLink =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent" }
  /** The server refused the address. */
  | { status: "refused" }
  | { status: "rate_limited" }
  /** Anything else, such as no connection, with the message to show. */
  | { status: "failed"; message: string };

export const EMAIL_HINT = "Enter an email address, like you@example.com.";

const isEmail = (value: string) => {
  const parsed = parseInvitee(value);
  return parsed !== null && "email" in parsed;
};

function EmailForm({
  link,
  onSend,
  autoFocus,
}: {
  link: EmailLink;
  onSend: (email: string) => void;
  autoFocus: boolean;
}) {
  const [email, setEmail] = useState("");
  // null until a submit fails; from then on each edit re-checks
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const refused = link.status === "refused";
  const [wasRefused, setWasRefused] = useState(refused);
  if (refused !== wasRefused) {
    setWasRefused(refused);
    if (refused) {
      setSubmitted(true);
      setFieldError(EMAIL_HINT);
    }
  }
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (refused) inputRef.current?.focus();
  }, [refused]);

  const sending = link.status === "sending";
  const ids = { email: useId(), error: useId() };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setSubmitted(true);
    if (!isEmail(email)) {
      setFieldError(EMAIL_HINT);
      inputRef.current?.focus();
      return;
    }
    setFieldError(null);
    onSend(email.trim());
  };

  return (
    <form noValidate onSubmit={submit} className="flex flex-col">
      <label htmlFor={ids.email} className="mb-1.5 font-medium">
        Email
      </label>
      <Input
        id={ids.email}
        ref={inputRef}
        type="email"
        autoComplete="email"
        autoFocus={autoFocus}
        placeholder="you@example.com"
        value={email}
        readOnly={sending}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setEmail(next);
          if (submitted) setFieldError(isEmail(next) ? null : EMAIL_HINT);
        }}
        aria-invalid={fieldError ? true : undefined}
        aria-describedby={fieldError ? ids.error : undefined}
        className={cn("h-11 lg:h-10", sending && "opacity-50")}
      />
      {fieldError && (
        <p id={ids.error} className="mt-1.5 text-xs text-destructive">
          {fieldError}
        </p>
      )}
      <Button
        type="submit"
        variant="outline"
        aria-disabled={sending || undefined}
        aria-busy={sending || undefined}
        className={cn(cardButton, "mt-2", sending && "opacity-50")}
      >
        {sending ? "Sending…" : "Email me a sign-in link"}
      </Button>
      {/* mounted while empty so a failure is announced when it arrives */}
      <p role="status" className="text-xs text-destructive not-empty:mt-2">
        {link.status === "rate_limited"
          ? "Too many requests, try again in a few minutes."
          : link.status === "failed"
            ? link.message
            : null}
      </p>
    </form>
  );
}

/** "Check your email", focused when it arrives: the form and the button pressed are gone. */
function LinkSent({
  onUseDifferentAddress,
}: {
  onUseDifferentAddress: () => void;
}) {
  const focusOnArrival = useCallback((panel: HTMLDivElement | null) => {
    panel?.focus();
  }, []);
  return (
    <>
      <div
        ref={focusOnArrival}
        tabIndex={-1}
        className="flex gap-2.5 rounded-xl border bg-card p-3 outline-none"
      >
        <MailIcon aria-hidden="true" className="mt-px size-4 shrink-0" />
        <div>
          <p className="font-medium">Check your email</p>
          <p className="mt-0.5 text-muted-foreground">
            If that address is invited, a link is on its way. It works for 15
            minutes.
          </p>
        </div>
      </div>
      <Button
        variant="ghost"
        className={cn(cardButton, "mt-2")}
        onClick={onUseDifferentAddress}
      >
        Use a different address
      </Button>
    </>
  );
}

/** `/sign-in`, signed out: GitHub, and a sign-in link by email when the server can send one. */
export function SignInView({
  onSignIn,
  pending = false,
  error,
  emailSignIn,
  expired = false,
  emailLink = { status: "idle" },
  onEmailLink,
  onUseDifferentAddress,
}: {
  /** Starts GitHub OAuth. */
  onSignIn: () => void;
  /** True once OAuth has started, so a second click doesn't start a second one. */
  pending?: boolean;
  /** Why the last GitHub sign-in couldn't start, such as GitHub sign-in not being set up. */
  error?: ReactNode;
  /** False when the server can't email a link: GitHub is the only way in. */
  emailSignIn: boolean;
  /** Arrived from a sign-in link that was used or had expired. */
  expired?: boolean;
  emailLink?: EmailLink;
  /** Asks for a link at this address, trimmed; called only with an email address. */
  onEmailLink: (email: string) => void;
  /** Leaves "Check your email" for the form again. */
  onUseDifferentAddress: () => void;
}) {
  const sent = emailLink.status === "sent";
  // the form comes back after "Check your email" only through this button, which it replaced
  const [cameBack, setCameBack] = useState(false);
  return (
    <SignInCard title="Sign in to trail">
      {expired && !sent ? (
        <Alert variant="destructive" className="mt-1 mb-5">
          <AlertTitle>That link didn't work</AlertTitle>
          <AlertDescription>
            Sign-in links work once and expire after 15 minutes. Request a new
            one below.
          </AlertDescription>
        </Alert>
      ) : (
        <p className="mb-5 text-muted-foreground">
          trail is where the bots track their work. Sign in with the GitHub
          account {emailSignIn && "or email address "}you were invited with.
        </p>
      )}
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
      {emailSignIn ? (
        <>
          <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
            or
          </div>
          {sent ? (
            <LinkSent
              onUseDifferentAddress={() => {
                setCameBack(true);
                onUseDifferentAddress();
              }}
            />
          ) : (
            <EmailForm
              link={emailLink}
              onSend={onEmailLink}
              autoFocus={cameBack}
            />
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Only invited people can sign in.
          </p>
        </>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Email sign-in isn't available right now. Only invited accounts can
          sign in.
        </p>
      )}
    </SignInCard>
  );
}

/** Who signed in and isn't on the list: a GitHub account, or an email address. */
export type Stranger = { login: string } | { email: string };

/** `/sign-in` after a sign-in that isn't on the list. Shows no project data. */
export function NotInvitedView({
  stranger,
  ownerName,
  onSignInAgain,
}: {
  stranger: Stranger;
  ownerName: string;
  /** Signs out, then offers sign-in again. */
  onSignInAgain: () => void;
}) {
  return (
    <SignInCard title="You're not invited yet">
      <p className="mb-5 text-muted-foreground">
        {"login" in stranger ? (
          <>
            <KeyText className="text-foreground">@{stranger.login}</KeyText>{" "}
            signed in with GitHub, but that account isn't on the list.
          </>
        ) : (
          <>
            <KeyText className="whitespace-normal wrap-anywhere text-foreground">
              {stranger.email}
            </KeyText>{" "}
            signed in by email, but that address isn't on the list.
          </>
        )}{" "}
        Ask {ownerName} to invite your GitHub username or email address, then
        sign in again.
      </p>
      <Button variant="outline" className={cardButton} onClick={onSignInAgain}>
        Sign in with a different account
      </Button>
    </SignInCard>
  );
}
