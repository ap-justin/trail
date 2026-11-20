// bounds the sign-in's wait on GitHub, as the photo fetch is bounded
const EMAIL_TIMEOUT_MS = 3_000;

const noreply = /@users\.noreply\.github\.com$/i;

type Listed = { email?: unknown; primary?: unknown; verified?: unknown };

/**
 * The address of the signed-in GitHub account that is both primary and
 * verified, from `/user/emails`; null when there is none, when the token lacks
 * the `user:email` scope, and on any failure, so a sign-in goes on without it.
 * Never an unverified address.
 */
export async function verifiedPrimaryEmail(
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  try {
    const response = await fetchFn("https://api.github.com/user/emails", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "trail",
      },
      redirect: "error",
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const listed: unknown = await response.json();
    if (!Array.isArray(listed)) return null;
    const found = (listed as Listed[]).find(
      (e) => e?.primary === true && e.verified === true,
    );
    const address = found?.email;
    // GitHub's stand-in for a private address takes no mail: not one a person can be reached at
    if (typeof address !== "string" || noreply.test(address)) return null;
    return address;
  } catch {
    return null;
  }
}
