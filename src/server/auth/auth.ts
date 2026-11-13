import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { samePath } from "../../shared/paths.js";
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
// the magic-link routes trail answers itself, as `loosePath` reads them
const linkRequestPath = "/api/auth/sign-in/magic-link";
const linkConfirmPath = "/api/auth/magic-link/confirm";
const linkVerifyPath = "/api/auth/magic-link/verify";

/**
 * A pathname read as loosely as any router might: percent-decoded, slashes
 * collapsed, no trailing slash, lowercased. Matching on it means no spelling of
 * a magic-link route slips past trail to better-auth's own.
 */
function loosePath(pathname: string): string {
  let path = pathname;
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      break;
    }
    if (decoded === path) break;
    path = decoded;
  }
  return path.replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase() || "/";
}

/**
 * The SPA page an emailed link opens; only its POST to /magic-link/confirm uses
 * the token. `email` is for the page to show: the token alone decides who signs in.
 */
const confirmPage = (token: string, callbackURL: string, email?: string) =>
  `/sign-in/confirm?${new URLSearchParams({ token, callbackURL, ...(email && { email }) })}`;

// Fly's proxy sets it and overwrites any value the client sent
const clientIpHeaders = ["fly-client-ip"];

const LINK_MINUTES = 15;
const linkWindowMs = LINK_MINUTES * 60_000;

const minutes = (seconds: number) => {
  const n = Math.ceil(seconds / 60);
  return n === 1 ? "1 minute" : `${n} minutes`;
};

const notFound = () => new Response("Not Found", { status: 404 });

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

  // every request counts, invited or not, so the limits say nothing about who is invited.
  // Per address across IPs only loosely: a strict one would let anyone lock a person out
  const linkLimits = [
    {
      key: (a: string, ip: string) => `${a} ${ip}`,
      ...windowLimiter({ max: 3, windowMs: linkWindowMs }),
    },
    {
      key: (_: string, ip: string) => ip,
      ...windowLimiter({ max: 10, windowMs: linkWindowMs }),
    },
    {
      key: (a: string) => a,
      ...windowLimiter({ max: 10, windowMs: 60 * 60_000 }),
    },
  ];

  const userRow = (userId: string) =>
    db.select().from(user).where(eq(user.id, userId)).get();

  /** What a signed-in user holds now: a GitHub account's access, or its email invite's. */
  const accessOfUser = (row: UserRow): Access | null =>
    row.githubId != null && row.githubLogin != null
      ? accessOf(db, row.githubId, row.githubLogin)
      : accessOfEmail(db, row.email);

  /** Sends the link, after the request has been answered and never failing it. */
  function deliverLink(to: string, token: string, callbackURL: string) {
    if (!email || !sendMail || !config.BETTER_AUTH_URL) return;
    const url = new URL(
      confirmPage(token, callbackURL, to),
      config.BETTER_AUTH_URL,
    ).toString();
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
            sendMagicLink: async ({ email: to, token, metadata }) => {
              const callbackURL = samePath(metadata?.callbackURL) ?? "/";
              if (isEmailInvited(db, to)) deliverLink(to, token, callbackURL);
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
    // the magic-link routes too: trail answers them in `handler` and calls the plugin through auth.api
    disabledPaths: [
      "/update-user",
      "/change-email",
      "/delete-user",
      "/sign-in/magic-link",
      "/magic-link/verify",
    ],
    // a failed GitHub callback lands on trail's sign-in page as ?error=<code>, not better-auth's own /api/auth/error
    onAPIError: { errorURL: "/sign-in" },
    advanced: {
      ipAddress: { ipAddressHeaders: clientIpHeaders },
    },
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

  async function isTrustedOrigin(request: Request): Promise<boolean> {
    const origin = request.headers.get("origin");
    if (!origin) return false;
    // without a baseURL better-auth trusts the origin it infers from each request
    if (!config.BETTER_AUTH_URL) return origin === new URL(request.url).origin;
    return (await auth.$context).isTrustedOrigin(origin);
  }

  const badOrigin = () =>
    errorJson(
      403,
      "INVALID_ORIGIN",
      "send the request from trail's own pages: its Origin header is missing or another site's",
    );

  const fieldsOf = async (
    request: Request,
  ): Promise<Record<string, unknown>> => {
    const body: unknown = await request.json().catch(() => null);
    return typeof body === "object" && body !== null ? { ...body } : {};
  };

  /**
   * `POST /api/auth/sign-in/magic-link` {email, callbackURL?}: checks the
   * origin, the address and the limits, then has the plugin make the token.
   * The plugin's own route is disabled, so nothing else rides along.
   */
  async function requestLink(request: Request): Promise<Response> {
    if (emailUnavailable) {
      return errorJson(503, "sign_in_unavailable", emailUnavailable);
    }
    if (!(await isTrustedOrigin(request))) return badOrigin();
    const fields = await fieldsOf(request);
    const invitee =
      typeof fields.email === "string" ? parseInvitee(fields.email) : null;
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
    const wait = Math.max(
      ...linkLimits.map((limit) => limit.wait(limit.key(address, ip))),
    );
    if (wait > 0) {
      return errorJson(
        429,
        "rate_limited",
        `too many sign-in links asked for: try again in ${minutes(wait)}`,
        { "retry-after": String(wait) },
      );
    }
    for (const limit of linkLimits) limit.take(limit.key(address, ip));
    const callbackURL = samePath(fields.callbackURL) ?? "/";
    return auth.api.signInMagicLink({
      body: { email: address, metadata: { callbackURL } },
      headers: request.headers,
      asResponse: true,
    });
  }

  /**
   * `POST /api/auth/magic-link/confirm` {token, callbackURL?}: the only use of
   * a link's token, made by the confirm page, so a mail scanner's GET can't
   * spend it. Sets the session cookie and answers where to go.
   */
  async function confirmLink(request: Request): Promise<Response> {
    if (!(await isTrustedOrigin(request))) return badOrigin();
    const fields = await fieldsOf(request);
    const redirectTo = samePath(fields.callbackURL) ?? "/";
    const verified =
      typeof fields.token === "string" && fields.token !== ""
        ? await auth.api.magicLinkVerify({
            query: { token: fields.token },
            headers: request.headers,
            asResponse: true,
          })
        : null;
    if (verified?.status === 200) {
      const res = Response.json({ redirectTo });
      for (const cookie of verified.headers.getSetCookie()) {
        res.headers.append("set-cookie", cookie);
      }
      return res;
    }
    // a failed verify redirects with ?error=<code>; INVALID_TOKEN covers expired, used and unknown tokens
    const location = verified?.headers.get("location") ?? "/";
    const code =
      new URL(location, "http://trail.invalid").searchParams.get("error") ??
      "INVALID_TOKEN";
    return code === "INVALID_TOKEN"
      ? errorJson(
          400,
          code,
          "this sign-in link was already used, has expired, or is not one trail sent: ask for a new one",
        )
      : errorJson(500, code, "the sign-in link could not be used: try again");
  }

  /**
   * Answers a magic-link route by `loosePath`, or null for any other route.
   * The plugin's GET verify never runs: it would let a mail scanner spend the
   * token, so it forwards to the confirm page instead.
   */
  async function magicLinkRoute(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = loosePath(url.pathname);
    const post = request.method === "POST";
    if (path === linkRequestPath)
      return post ? requestLink(request) : notFound();
    if (!email) {
      return path === linkConfirmPath || path === linkVerifyPath
        ? notFound()
        : null;
    }
    if (path === linkConfirmPath)
      return post ? confirmLink(request) : notFound();
    if (path === linkVerifyPath) {
      const token = url.searchParams.get("token") ?? "";
      const callbackURL = samePath(url.searchParams.get("callbackURL")) ?? "/";
      return new Response(null, {
        status: 302,
        headers: { location: confirmPage(token, callbackURL) },
      });
    }
    return null;
  }

  const trail: TrailAuth = {
    ownerLogin: owner,
    emailSignIn: email !== null,
    isTrustedOrigin,
    async handler(request) {
      const link = await magicLinkRoute(request);
      if (link) return link;
      const path = new URL(request.url).pathname;
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
