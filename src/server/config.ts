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
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    // the GitHub username whose sign-in is the owner, matched ignoring case
    TRAIL_OWNER_GITHUB: z
      .string()
      .trim()
      .min(1)
      .transform((v) => v.toLowerCase()),
    // signs session cookies and OAuth state; better-auth asks for 32+ characters
    BETTER_AUTH_SECRET: z.string().min(32),
    // the public origin, e.g. https://trail.fly.dev: behind a TLS-terminating proxy
    // the request URL says http, which would put http in GitHub's redirect_uri
    BETTER_AUTH_URL: optional.pipe(z.url().optional()),
    GITHUB_CLIENT_ID: optional,
    GITHUB_CLIENT_SECRET: optional,
  })
  .transform(({ GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ...rest }) => ({
    ...rest,
    github: githubOAuth(GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET),
  }));

export type GitHubOAuth =
  | { clientId: string; clientSecret: string }
  | { missing: string[] };

function githubOAuth(clientId?: string, clientSecret?: string): GitHubOAuth {
  if (clientId && clientSecret) return { clientId, clientSecret };
  const missing: string[] = [];
  if (!clientId) missing.push("GITHUB_CLIENT_ID");
  if (!clientSecret) missing.push("GITHUB_CLIENT_SECRET");
  return { missing };
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
