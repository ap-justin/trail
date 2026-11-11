import { type BetterAuthPlugin, betterAuth } from "better-auth";
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
  /** Who the request's session cookie belongs to, read fresh from the database. */
  resolveViewer(headers: Headers): Promise<Viewer>;
  /** Sets `c.var.viewer`, and passes on a refreshed session cookie. */
  viewer: MiddlewareHandler<ViewerEnv>;
}

// the routes that start or finish a GitHub sign-in
const signInPath = /^\/api\/auth\/(sign-in\/social|callback\/github)\/?$/;

export function createAuth({
  db,
  config,
  plugins = [],
}: {
  db: Db;
  config: AuthConfig;
  /** for tests: better-auth's `testUtils` */
  plugins?: BetterAuthPlugin[];
}) {
  const owner = config.TRAIL_OWNER_GITHUB;
  const github = "clientId" in config.github ? config.github : null;
  const signInUnavailable =
    "missing" in config.github
      ? `GitHub sign-in is not configured: set ${config.github.missing.join(" and ")}`
      : null;

  /** A better-auth user's login, and its actor (created or refreshed) while it is let in. */
  function syncUser(userId: string) {
    const row = db.select().from(user).where(eq(user.id, userId)).get();
    if (!row) return null;
    const identity = {
      githubId: row.githubId,
      login: row.githubLogin,
      name: row.name,
    };
    return { login: row.githubLogin, letIn: syncActor(db, identity, owner) };
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
            // a renamed GitHub account brings its new login and name to the next sign-in
            overrideUserInfoOnSignIn: true,
            mapProfileToUser: (profile) => ({
              githubId: profile.id,
              githubLogin: profile.login.toLowerCase(),
            }),
          },
        }
      : {},
    // one GitHub account is one user: never join a second account to a user by matching email
    account: { accountLinking: { enabled: false } },
    disabledPaths: ["/update-user", "/change-email", "/delete-user"],
    advanced: {
      // Fly's proxy sets it and overwrites any value the client sent
      ipAddress: { ipAddressHeaders: ["fly-client-ip"] },
    },
    databaseHooks: {
      session: {
        create: {
          // every sign-in creates a session
          after: async ({ userId }) => {
            syncUser(userId);
          },
        },
      },
    },
    plugins,
  });

  async function sessionOf(headers: Headers) {
    // no Authorization: a bot's key never makes a viewer, and better-auth has no bearer plugin here
    const cookieOnly = new Headers();
    const cookie = headers.get("cookie");
    if (cookie) cookieOnly.set("cookie", cookie);
    return auth.api.getSession({ headers: cookieOnly, returnHeaders: true });
  }

  function viewerFor(userId: string | undefined): Viewer {
    if (!userId) return { kind: "anonymous" };
    const synced = syncUser(userId);
    if (!synced) return { kind: "anonymous" };
    if (!synced.letIn) return { kind: "not_invited", login: synced.login };
    const { actor, isOwner } = synced.letIn;
    return {
      kind: isOwner ? "owner" : "member",
      login: synced.login,
      actor,
      projects: visibleProjects(db, synced.login, isOwner),
    };
  }

  const trail: TrailAuth = {
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
      const { response } = await sessionOf(headers);
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

  // $context is for test-app.ts, whose testUtils plugin hangs its helpers there
  return { ...trail, $context: auth.$context };
}
