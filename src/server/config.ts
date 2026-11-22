import { z } from "zod";

const databaseSchema = z.object({
  DATABASE_PATH: z.string().min(1).default("./data/trail.db"),
});

// an unset variable and one set to "" both read as absent
const optional = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const serverSchema = databaseSchema
  .extend({
    // digits only: z.coerce.number() reads "" as 0, a random port
    PORT: z
      .string()
      .regex(/^\d+$/, "must be a port number")
      .default("3000")
      .transform(Number)
      .pipe(z.number().max(65535)),
    // the GitHub username whose first sign-in claims the owner, matched ignoring case;
    // the same shape as actor.github_login's CHECK in db/schema.ts, so the claim can be stored
    TRAIL_OWNER_GITHUB: z
      .string()
      .max(39)
      .toLowerCase()
      .regex(
        /^[a-z0-9](?:-?[a-z0-9])*$/,
        "must be a GitHub username (letters, digits, single inner hyphens; no @)",
      ),
    // signs session cookies and OAuth state; better-auth asks for 32+ characters
    BETTER_AUTH_SECRET: z.string().min(32),
    // the public origin, e.g. https://trail.fly.dev, which GitHub sign-in needs: behind
    // a TLS-terminating proxy the request URL says http, and so would the redirect_uri
    BETTER_AUTH_URL: optional.pipe(z.url().optional()),
    GITHUB_CLIENT_ID: optional,
    GITHUB_CLIENT_SECRET: optional,
    // sent to GitHub's API when the server reads a pull request's state for a link on an item: with it,
    // private repos the token can read and a faster fetch rate; without it, public repos only
    GITHUB_TOKEN: optional,
    // the sign-in email's From, e.g. `trail <trail@mail.example.com>`, on a domain Resend has verified
    EMAIL_FROM: optional,
    RESEND_API_KEY: optional,
    // a Sky preview's test sign-in; never set on a real deploy. Only "1" turns it on
    TRAIL_PREVIEW_MODE: optional,
    // set on every Fly Machine, so preview mode can tell it is on a real deploy
    FLY_APP_NAME: optional,
    FLY_MACHINE_ID: optional,
  })
  .transform(
    (
      {
        GITHUB_CLIENT_ID,
        GITHUB_CLIENT_SECRET,
        EMAIL_FROM,
        RESEND_API_KEY,
        TRAIL_PREVIEW_MODE,
        FLY_APP_NAME,
        FLY_MACHINE_ID,
        ...rest
      },
      ctx,
    ) => ({
      ...rest,
      preview: previewMode(
        TRAIL_PREVIEW_MODE,
        Boolean(FLY_APP_NAME || FLY_MACHINE_ID),
        ctx,
      ),
      github: githubOAuth({
        GITHUB_CLIENT_ID,
        GITHUB_CLIENT_SECRET,
        BETTER_AUTH_URL: rest.BETTER_AUTH_URL,
      }),
      email: emailSignIn({
        EMAIL_FROM,
        RESEND_API_KEY,
        BETTER_AUTH_URL: rest.BETTER_AUTH_URL,
      }),
    }),
  );

export type GitHubOAuth =
  | { clientId: string; clientSecret: string }
  | { missing: string[] };

export type EmailSignIn =
  | { from: string; resendApiKey: string }
  | { missing: string[] };

const missingOf = (vars: Record<string, string | undefined>) =>
  Object.entries(vars)
    .filter(([, value]) => !value)
    .map(([name]) => name);

/** GitHub sign-in's credentials, or the variables it still needs. */
function githubOAuth(
  vars: Record<
    "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET" | "BETTER_AUTH_URL",
    string | undefined
  >,
): GitHubOAuth {
  const missing = missingOf(vars);
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } =
    vars;
  if (missing.length > 0 || !clientId || !clientSecret) return { missing };
  return { clientId, clientSecret };
}

/**
 * Email sign-in's sender and Resend key, or the variables it still needs. It
 * needs BETTER_AUTH_URL too: without it the link would be built from the
 * request's Host, which a requester could point at their own server.
 */
function emailSignIn(
  vars: Record<
    "EMAIL_FROM" | "RESEND_API_KEY" | "BETTER_AUTH_URL",
    string | undefined
  >,
): EmailSignIn {
  const missing = missingOf(vars);
  const { EMAIL_FROM: from, RESEND_API_KEY: resendApiKey } = vars;
  if (missing.length > 0 || !from || !resendApiKey) return { missing };
  return { from, resendApiKey };
}

/** True when a Sky preview's test sign-in is on, null when preview mode is off. */
export type Preview = true | null;

function previewMode(
  mode: string | undefined,
  onFly: boolean,
  ctx: z.RefinementCtx,
): Preview {
  if (mode !== "1") return null;
  if (onFly) {
    ctx.addIssue({
      code: "custom",
      path: ["TRAIL_PREVIEW_MODE"],
      message:
        "TRAIL_PREVIEW_MODE=1 opens a sign-in as the owner with no password, and this runs on Fly (FLY_APP_NAME or FLY_MACHINE_ID is set): unset TRAIL_PREVIEW_MODE",
    });
    return z.NEVER;
  }
  return true;
}

export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type Config = z.infer<typeof serverSchema>;

/** The server's environment; throws naming each missing or invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return serverSchema.parse(env);
}

/** What the CLI and `db:migrate` read: only the database, no auth secrets. */
export function loadDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  return databaseSchema.parse(env);
}
