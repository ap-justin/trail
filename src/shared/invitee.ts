// zod/mini and nothing from the server, so the web app can import it as a value:
// schemas.ts may only be type-imported there (.biome/web-type-only-server-imports.grit)
import * as z from "zod/mini";

// GitHub's username rule, checked after lowercasing: 1-39 of a-z, 0-9 and single inner hyphens
const githubUsername = z
  .string()
  .check(z.maxLength(39), z.regex(/^[a-z0-9](?:-?[a-z0-9]){0,38}$/));
// 254: the longest address SMTP carries
const emailAddress = z.email().check(z.maxLength(254));

export const INVITEE_HINT =
  "Enter a GitHub username or an email address, like devon-r or devon@example.com.";

/**
 * Whom an invite entry names, decided by shape: with an @ it is an email
 * address, without one a GitHub username. Trimmed and lowercased; null when it
 * is neither.
 */
export function parseInvitee(
  entry: string,
): { username: string } | { email: string } | null {
  const value = entry.trim().toLowerCase();
  if (value.includes("@")) {
    return emailAddress.safeParse(value).success ? { email: value } : null;
  }
  return githubUsername.safeParse(value).success ? { username: value } : null;
}
