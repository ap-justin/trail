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
    // the sign-in email's From, e.g. `trail <trail@mail.example.com>`, on a domain Resend has verified
    EMAIL_FROM: optional,
    RESEND_API_KEY: optional,
  })
  .transform(
    ({
      GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET,
      EMAIL_FROM,
      RESEND_API_KEY,
      ...rest
    }) => ({
      ...rest,
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
