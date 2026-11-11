import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { account, session, user, verification } from "../db/schema.js";
import { syncActor, visibleProjects } from "./identity.js";
import type { Viewer, ViewerEnv } from "./viewer.js";

export type AuthConfig = Pick<
  Config,
  "TRAIL_OWNER_GITHUB" | "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL" | "github"
>;

/** Human sign-in as the rest of the server sees it, with better-auth kept inside. */
export interface TrailAuth {
  /** Serves `/api/auth/*`. */
  handler(request: Request): Promise<Response>;
  /**
   * Who the request's session cookie belongs to, read fresh from the database
   * without sliding the session's expiry, so a caller polling it can't keep it alive.
   */
  resolveViewer(headers: Headers): Promise<Viewer>;
  /** Sets `c.var.viewer`, and passes on a refreshed session cookie. */
  viewer: MiddlewareHandler<ViewerEnv>;
  /** The owner's GitHub login, lowercased. */
  ownerLogin: string;
  /**
   * Whether the request's Origin is one better-auth trusts: BETTER_AUTH_URL's
   * origin (and any trustedOrigins), or without it the request's own origin.
   */
  isTrustedOrigin(request: Request): Promise<boolean>;
}

const noTokens = { accessToken: null, refreshToken: null, idToken: null };

// the routes that start or finish a GitHub sign-in
const signInPath = /^\/api\/auth\/(sign-in\/social|callback\/github)\/?$/;

export function createAuth({
  db,
  config,
}: {
  db: Db;
  config: AuthConfig;
}): TrailAuth {
  const owner = config.TRAIL_OWNER_GITHUB;
  const github = "clientId" in config.github ? config.github : null;
  const signInUnavailable =
    "missing" in config.github
      ? `GitHub sign-in is not configured: set ${config.github.missing.join(" and ")}`
      : null;

  /** A better-auth user's current login, and its access while it is let in. */
  function syncUser(userId: string) {
    const row = db.select().from(user).where(eq(user.id, userId)).get();
    if (!row) return null;
    const identity = {
      githubId: row.githubId,
      login: row.githubLogin,
      name: row.name,
    };
    return { login: row.githubLogin, access: syncActor(db, identity, owner) };
  }

  const auth = betterAuth({
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user, session, account, verification },
    }),
    user: {
      additionalFields: {
        // input: mapProfileToUser's output is parsed as user input and only input fields
        // are kept; /update-user, the endpoint that would take them from a person, is off
        githubId: { type: "number", required: true, input: true },
        githubLogin: { type: "string", required: true, input: true },
      },
    },
    socialProviders: github
      ? {
          github: {
            clientId: github.clientId,
            clientSecret: github.clientSecret,
            // without it GitHub signs straight back into its current account, so a
            // not-invited person could never switch to the account that was invited
            prompt: "select_account",
            // a renamed GitHub account brings its new login and name to the next sign-in
            overrideUserInfoOnSignIn: true,
            mapProfileToUser: (profile) => ({
              // email is unique on better-auth's user row and trail never reads it: a real
              // address moved between GitHub accounts would lock the second one out
              email: `${profile.id}@users.noreply.github.com`,
              githubId: profile.id,
              githubLogin: profile.login.toLowerCase(),
            }),
          },
        }
      : {},
    // one GitHub account is one user: never join a second account to a user by matching email
    account: { accountLinking: { enabled: false } },
    disabledPaths: ["/update-user", "/change-email", "/delete-user"],
    // a failed GitHub callback lands on trail's sign-in page as ?error=<code>, not better-auth's own /api/auth/error
    onAPIError: { errorURL: "/sign-in" },
    advanced: {
      // Fly's proxy sets it and overwrites any value the client sent
      ipAddress: { ipAddressHeaders: ["fly-client-ip"] },
    },
    databaseHooks: {
      // trail never calls GitHub as a person, so their tokens are never kept
      account: {
        create: { before: async (row) => ({ data: { ...row, ...noTokens } }) },
        update: { before: async (row) => ({ data: { ...row, ...noTokens } }) },
      },
      session: {
        create: {
          // every sign-in creates a session
          after: async ({ userId }) => {
            syncUser(userId);
          },
        },
      },
    },
  });

  async function sessionOf(
    headers: Headers,
    query?: { disableRefresh: boolean },
  ) {
    // no Authorization: a bot's key never makes a viewer, and better-auth has no bearer plugin here
    const cookieOnly = new Headers();
    const cookie = headers.get("cookie");
    if (cookie) cookieOnly.set("cookie", cookie);
    return auth.api.getSession({
      headers: cookieOnly,
      query,
      returnHeaders: true,
    });
  }

  function viewerFor(userId: string | undefined): Viewer {
    if (!userId) return { kind: "anonymous" };
    const synced = syncUser(userId);
    if (!synced) return { kind: "anonymous" };
    const { login, access } = synced;
    if (!access) return { kind: "not_invited", login };
    return {
      kind: access.isOwner ? "owner" : "member",
      login,
      actor: access.actor,
      projects: visibleProjects(db, access),
    };
  }

  const trail: TrailAuth = {
    ownerLogin: owner,
    async isTrustedOrigin(request) {
      const origin = request.headers.get("origin");
      if (!origin) return false;
      // without a baseURL better-auth trusts the origin it infers from each request
      if (!config.BETTER_AUTH_URL)
        return origin === new URL(request.url).origin;
      return (await auth.$context).isTrustedOrigin(origin);
    },
    async handler(request) {
      if (signInUnavailable && signInPath.test(new URL(request.url).pathname)) {
        const error = {
          code: "sign_in_unavailable",
          message: signInUnavailable,
        };
        return Response.json({ error }, { status: 503 });
      }
      return auth.handler(request);
    },
    async resolveViewer(headers) {
      const { response } = await sessionOf(headers, { disableRefresh: true });
      return viewerFor(response?.user.id);
    },
    viewer: async (c, next) => {
      const { response, headers } = await sessionOf(c.req.raw.headers);
      c.set("viewer", viewerFor(response?.user.id));
      await next();
      for (const cookie of headers.getSetCookie()) {
        c.res.headers.append("set-cookie", cookie);
      }
    },
  };

  return trail;
}
