import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { errorJson } from "./error-json.js";
import { windowLimiter } from "./limit.js";

/**
 * The made-up GitHub account a preview's test sign-in signs in as, under the
 * owner's login so its first sign-in claims the owner seat.
 */
const PREVIEW_GITHUB_ID = 900_000_001;
export const PREVIEW_PERSON = {
  githubId: PREVIEW_GITHUB_ID,
  name: "Preview Owner",
  // the same shape as a GitHub sign-in's user row, in auth.ts's mapProfileToUser
  email: `${PREVIEW_GITHUB_ID}@users.noreply.github.com`,
};

const firstValue = (header: string | null) =>
  header?.split(",")[0]?.trim().toLowerCase() || null;

const bareHost =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?$/;

/**
 * The origin a proxy says the browser used, from X-Forwarded-Proto and
 * X-Forwarded-Host, or null without a usable pair. Sky's preview proxy rewrites
 * Host to its loopback upstream but passes the browser's Origin through, so a
 * same-origin request looks cross-origin without this.
 *
 * Both headers are the client's to set: trusting them is safe only because
 * preview mode never runs on a public deploy.
 */
export function forwardedOrigin(headers: Headers): string | null {
  const proto = firstValue(headers.get("x-forwarded-proto"));
  const host = firstValue(headers.get("x-forwarded-host"));
  if ((proto !== "https" && proto !== "http") || !host || !bareHost.test(host))
    return null;
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    // a port past 65535
    return null;
  }
}

/**
 * Adds `auth.api.previewSessionForOwner`, which finds or makes the preview
 * person's user row and gives it a session the normal way, so the session
 * hooks claim the owner. Server-only: the router never serves it.
 */
export const previewSessions = (ownerLogin: string) =>
  ({
    id: "trail-preview",
    endpoints: {
      previewSessionForOwner: createAuthEndpoint.serverOnly(
        { method: "POST" },
        async (ctx) => {
          const adapter = ctx.context.internalAdapter;
          const found = await adapter.findUserByEmail(PREVIEW_PERSON.email);
          const person = found
            ? // the owner's login as it is now: TRAIL_OWNER_GITHUB may differ from the last boot's
              await adapter.updateUser(found.user.id, {
                githubLogin: ownerLogin,
              })
            : await adapter
                .createUser(
                  {
                    email: PREVIEW_PERSON.email,
                    name: PREVIEW_PERSON.name,
                    emailVerified: true,
                    githubId: PREVIEW_PERSON.githubId,
                    githubLogin: ownerLogin,
                  },
                  { method: "trail-preview" },
                )
                .catch(async (error: unknown) => {
                  // a sign-in sent at the same moment made the row first
                  const made = await adapter.findUserByEmail(
                    PREVIEW_PERSON.email,
                  );
                  if (!made) throw error;
                  return made.user;
                });
          const session = await adapter.createSession(person.id);
          await setSessionCookie(ctx, { session, user: person });
          return ctx.json({});
        },
      ),
    },
  }) satisfies BetterAuthPlugin;

// any port; hostnames match ignoring case
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

/**
 * Whether the request's Host is loopback, as Sky's preview proxy always sends
 * it. Without a Host header, as from `app.request`, the URL's host stands in:
 * `@hono/node-server` builds the URL from Host.
 */
export function isLoopbackHost(request: Request): boolean {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  return loopbackHost.test(host);
}

/**
 * `POST /api/preview/sign-in`, with no body: checks the origin and the limit,
 * then signs in the preview person with the session cookie `sessionForOwner`
 * sets. The route serves it only for a loopback Host (`isLoopbackHost`).
 */
export function previewSignIn({
  isTrustedOrigin,
  sessionForOwner,
}: {
  isTrustedOrigin(request: Request): Promise<boolean>;
  /** a response carrying the new session's Set-Cookie */
  sessionForOwner(headers: Headers): Promise<Response>;
}): (request: Request) => Promise<Response> {
  // one window for every caller: a preview has one tester
  const attempts = windowLimiter({ max: 10, windowMs: 60_000 });

  return async (request) => {
    if (!(await isTrustedOrigin(request))) {
      return errorJson(
        403,
        "INVALID_ORIGIN",
        "send the request from trail's own pages: its Origin header is missing or another site's",
      );
    }
    const wait = attempts.wait("all");
    if (wait > 0) {
      return errorJson(
        429,
        "rate_limited",
        `too many preview sign-ins: try again in ${wait} seconds`,
        { "retry-after": String(wait) },
      );
    }
    // taken with the check, before any await, so sign-ins sent at once can't all pass it
    attempts.take("all");
    const signedIn = await sessionForOwner(request.headers);
    if (!signedIn.ok) {
      return errorJson(
        500,
        "sign_in_failed",
        "the preview sign-in failed: try again",
      );
    }
    const res = Response.json({ redirectTo: "/" });
    for (const cookie of signedIn.headers.getSetCookie()) {
      res.headers.append("set-cookie", cookie);
    }
    return res;
  };
}
