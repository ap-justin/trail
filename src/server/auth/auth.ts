import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { parseInvitee } from "../../shared/schemas.js";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { account, session, user, verification } from "../db/schema.js";
import { storeGitHubPhoto } from "./avatar.js";
import {
  type Access,
  accessOf,
  accessOfEmail,
  isEmailInvited,
  syncActor,
  syncEmailActor,
  visibleProjects,
} from "./identity.js";
import { windowLimiter } from "./limit.js";
import { type MailTransport, resendTransport, signInEmail } from "./mail.js";
import type { Viewer, ViewerEnv } from "./viewer.js";

export type AuthConfig = Pick<
  Config,
  | "TRAIL_OWNER_GITHUB"
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_URL"
  | "github"
  | "email"
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
  /**
   * Whether the request's session cookie belongs to the owner or an invited
   * person: `resolveViewer`'s member/owner answer, read the same way without
   * building the viewer, so it costs the session, its user and the access only.
   */
  isLetIn(headers: Headers): Promise<boolean>;
  /** Sets `c.var.viewer`, and passes on a refreshed session cookie. */
  viewer: MiddlewareHandler<ViewerEnv>;
  /** The owner's GitHub login, lowercased. */
  ownerLogin: string;
  /** Whether email sign-in is configured, so a link can be asked for. */
  emailSignIn: boolean;
  /**
   * Whether the request's Origin is one better-auth trusts: BETTER_AUTH_URL's
   * origin (and any trustedOrigins), or without it the request's own origin.
   */
  isTrustedOrigin(request: Request): Promise<boolean>;
}

const noTokens = { accessToken: null, refreshToken: null, idToken: null };

// the routes that start or finish a GitHub sign-in
const signInPath = /^\/api\/auth\/(sign-in\/social|callback\/github)\/?$/;
// the route that asks for a sign-in link
const linkRequestPath = /^\/api\/auth\/sign-in\/magic-link\/?$/;

// Fly's proxy sets it and overwrites any value the client sent
const clientIpHeaders = ["fly-client-ip"];

const LINK_MINUTES = 15;
const linkWindowMs = LINK_MINUTES * 60_000;

/** A JSON error as the rest of trail's API answers one. */
const errorJson = (
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
) => Response.json({ error: { code, message } }, { status, headers });

type UserRow = {
  email: string;
  githubId?: number | null;
  githubLogin?: string | null;
};

export function createAuth({
  db,
  config,
  avatarFetch = fetch,
  mailTransport,
}: {
  db: Db;
  config: AuthConfig;
  /** fetches a person's GitHub photo at sign-in */
  avatarFetch?: typeof fetch;
  /** sends sign-in emails; Resend with RESEND_API_KEY by default */
  mailTransport?: MailTransport;
}): TrailAuth {
  const owner = config.TRAIL_OWNER_GITHUB;
  const github = "clientId" in config.github ? config.github : null;
  const signInUnavailable =
    "missing" in config.github
      ? `GitHub sign-in is not configured: set ${config.github.missing.join(" and ")}`
      : null;

  const email = "from" in config.email ? config.email : null;
  const emailUnavailable =
    "missing" in config.email
      ? `Email sign-in is not configured: set ${config.email.missing.join(" and ")}`
      : null;
  const sendMail =
    mailTransport ?? (email ? resendTransport(email.resendApiKey) : null);

  // every request counts, invited or not, so the limit says nothing about who is invited
  const linksPerAddress = windowLimiter({ max: 3, windowMs: linkWindowMs });
  const linksPerIp = windowLimiter({ max: 10, windowMs: linkWindowMs });

  const userRow = (userId: string) =>
    db.select().from(user).where(eq(user.id, userId)).get();

  /** What a signed-in user holds now: a GitHub account's access, or its email invite's. */
  const accessOfUser = (row: UserRow): Access | null =>
    row.githubId != null && row.githubLogin != null
      ? accessOf(db, row.githubId, row.githubLogin)
      : accessOfEmail(db, row.email);

  /** Sends the link, after the request has been answered and never failing it. */
  function deliverLink(to: string, url: string) {
    if (!email || !sendMail) return;
    setImmediate(() => {
      sendMail({ from: email.from, to, ...signInEmail(url) }).catch(
        (e: unknown) => {
          const reason = e instanceof Error ? e.message : String(e);
          console.warn(`sign-in email to ${to} not sent: ${reason}`);
        },
      );
    });
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
        // are kept; /update-user, the endpoint that would take them from a person, is off.
        // Not required: a person signed in by email has neither
        githubId: { type: "number", required: false, input: true },
        githubLogin: { type: "string", required: false, input: true },
      },
    },
    plugins: email
      ? [
          magicLink({
            expiresIn: LINK_MINUTES * 60,
            // a leaked database holds no live link
            storeToken: "hashed",
            // called for every address alike, so the answer and its timing don't tell who is invited
            sendMagicLink: async ({ email: to, url }) => {
              if (isEmailInvited(db, to)) deliverLink(to, url);
            },
          }),
        ]
      : [],
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
      ipAddress: { ipAddressHeaders: clientIpHeaders },
    },
    // asking for a link is limited per address and per IP in `requestLink`; verifying keeps the plugin's limit
    rateLimit: { customRules: { "/sign-in/magic-link": false } },
    databaseHooks: {
      // trail never calls GitHub as a person, so their tokens are never kept
      account: {
        create: { before: async (row) => ({ data: { ...row, ...noTokens } }) },
        update: { before: async (row) => ({ data: { ...row, ...noTokens } }) },
      },
      session: {
        create: {
          // every sign-in creates a session, and only a sign-in claims: the GitHub callback
          // rewrites the user row from the profile it just fetched before it gets here
          after: async ({ userId }) => {
            const row = userRow(userId);
            if (!row) return;
            // a magic-link sign-in: better-auth made the user from the address the link proved
            if (row.githubId === null || row.githubLogin === null) {
              syncEmailActor(db, row.email);
              return;
            }
            const identity = {
              githubId: row.githubId,
              login: row.githubLogin,
              name: row.name,
            };
            const access = syncActor(db, identity, owner);
            // not awaited: sign-in never waits on GitHub, and storeGitHubPhoto never rejects
            if (access) void storeGitHubPhoto(db, access.actor, avatarFetch);
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
    const row = userRow(userId);
    if (!row) return { kind: "anonymous" };
    // the stored login may be one the account has since given up: show it, never claim with it
    const login = row.githubLogin;
    const access = accessOfUser(row);
    if (!access) {
      return login === null
        ? { kind: "not_invited", login: null, email: row.email }
        : { kind: "not_invited", login };
    }
    return {
      kind: access.isOwner ? "owner" : "member",
      login,
      actor: access.actor,
      projects: visibleProjects(db, access),
    };
  }

  /**
   * `POST /api/auth/sign-in/magic-link`, in front of better-auth's: checks the
   * address and the limits, then hands better-auth a body trail wrote, so an
   * error always lands on /sign-in and nothing else rides along.
   */
  async function requestLink(request: Request): Promise<Response> {
    if (emailUnavailable) {
      return errorJson(503, "sign_in_unavailable", emailUnavailable);
    }
    const body: unknown = await request.json().catch(() => null);
    const fields = (typeof body === "object" && body) || {};
    const entry = "email" in fields ? fields.email : undefined;
    const invitee = typeof entry === "string" ? parseInvitee(entry) : null;
    if (!invitee || !("email" in invitee)) {
      return errorJson(
        400,
        "invalid_email",
        "send a JSON body with the email address to sign in with, like dana@example.com",
      );
    }
    const address = invitee.email;
    const ip =
      clientIpHeaders.map((h) => request.headers.get(h)).find(Boolean) ??
      "unknown";
    const wait = Math.max(linksPerAddress.wait(address), linksPerIp.wait(ip));
    if (wait > 0) {
      return errorJson(
        429,
        "rate_limited",
        `too many sign-in links asked for: try again in ${Math.ceil(wait / 60)} minutes`,
        { "retry-after": String(wait) },
      );
    }
    linksPerAddress.take(address);
    linksPerIp.take(ip);
    const callbackURL =
      "callbackURL" in fields && typeof fields.callbackURL === "string"
        ? fields.callbackURL
        : "/";
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    return auth.handler(
      new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: address,
          callbackURL,
          errorCallbackURL: "/sign-in",
        }),
      }),
    );
  }

  const trail: TrailAuth = {
    ownerLogin: owner,
    emailSignIn: email !== null,
    async isTrustedOrigin(request) {
      const origin = request.headers.get("origin");
      if (!origin) return false;
      // without a baseURL better-auth trusts the origin it infers from each request
      if (!config.BETTER_AUTH_URL)
        return origin === new URL(request.url).origin;
      return (await auth.$context).isTrustedOrigin(origin);
    },
    async handler(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && linkRequestPath.test(path)) {
        return requestLink(request);
      }
      if (signInUnavailable && signInPath.test(path)) {
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
    async isLetIn(headers) {
      const { response } = await sessionOf(headers, { disableRefresh: true });
      if (!response) return false;
      return accessOfUser(response.user) !== null;
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
