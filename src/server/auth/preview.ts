import { createHash, timingSafeEqual } from "node:crypto";
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
          const found = await ctx.context.internalAdapter.findUserByEmail(
            PREVIEW_PERSON.email,
          );
          const person = found
            ? // the owner's login as it is now: TRAIL_OWNER_GITHUB may differ from the last boot's
              await ctx.context.internalAdapter.updateUser(found.user.id, {
                githubLogin: ownerLogin,
              })
            : await ctx.context.internalAdapter.createUser(
                {
                  email: PREVIEW_PERSON.email,
                  name: PREVIEW_PERSON.name,
                  emailVerified: true,
                  githubId: PREVIEW_PERSON.githubId,
                  githubLogin: ownerLogin,
                },
                { method: "trail-preview" },
              );
          const session = await ctx.context.internalAdapter.createSession(
            person.id,
          );
          await setSessionCookie(ctx, { session, user: person });
          return ctx.json({});
        },
      ),
    },
  }) satisfies BetterAuthPlugin;

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * `POST /api/preview/sign-in` {password}: checks the origin, the limit and the
 * password, then signs in the preview person with the session cookie
 * `sessionForOwner` sets.
 */
export function previewSignIn({
  password,
  isTrustedOrigin,
  sessionForOwner,
}: {
  password: string;
  isTrustedOrigin(request: Request): Promise<boolean>;
  /** a response carrying the new session's Set-Cookie */
  sessionForOwner(headers: Headers): Promise<Response>;
}): (request: Request) => Promise<Response> {
  // compared as digests, so the comparison takes as long whatever the guess's length
  const expected = digest(password);
  // one window for every caller: a preview has one tester, and the password resists guessing anyway
  const failures = windowLimiter({ max: 10, windowMs: 60_000 });

  return async (request) => {
    if (!(await isTrustedOrigin(request))) {
      return errorJson(
        403,
        "INVALID_ORIGIN",
        "send the request from trail's own pages: its Origin header is missing or another site's",
      );
    }
    const wait = failures.wait("all");
    if (wait > 0) {
      return errorJson(
        429,
        "rate_limited",
        `too many wrong preview passwords: try again in ${wait} seconds`,
        { "retry-after": String(wait) },
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorJson(
        400,
        "invalid_json",
        'send a JSON body like {"password": "..."}',
      );
    }
    const given =
      typeof body === "object" && body !== null && "password" in body
        ? body.password
        : undefined;
    if (
      typeof given !== "string" ||
      !timingSafeEqual(digest(given), expected)
    ) {
      failures.take("all");
      return errorJson(
        401,
        "invalid_password",
        "that is not this preview's password",
      );
    }
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
