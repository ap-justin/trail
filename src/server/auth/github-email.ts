// sign-in doesn't wait on the read; this bounds how long the background read can run
const EMAIL_TIMEOUT_MS = 3_000;

const noreply = /@users\.noreply\.github\.com$/i;

type Listed = { email?: unknown; primary?: unknown; verified?: unknown };

/** Why GitHub couldn't be read, in words that never carry the token. */
function unread(e: unknown): Error {
  if (e instanceof Error && e.name === "TimeoutError") {
    return new Error(
      `GitHub /user/emails timed out after ${EMAIL_TIMEOUT_MS}ms`,
    );
  }
  if (e instanceof SyntaxError) {
    return new Error("GitHub /user/emails answered a body that isn't JSON");
  }
  const reason = e instanceof Error ? e.message : String(e);
  return new Error(`GitHub /user/emails unreachable: ${reason}`);
}

/**
 * The address of the signed-in GitHub account that is both primary and
 * verified, from `/user/emails`; null when there is none and when GitHub
 * answers 404, its answer to a token without the `user:email` scope. Rejects,
 * with the cause and never the token, on any other status, an unreachable or
 * slow GitHub, or an answer that isn't a JSON list. Never an unverified address.
 */
export async function verifiedPrimaryEmail(
  accessToken: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchFn("https://api.github.com/user/emails", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "trail",
      },
      redirect: "error",
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    });
  } catch (e) {
    throw unread(e);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub /user/emails answered ${response.status}`);
  }
  let listed: unknown;
  try {
    listed = await response.json();
  } catch (e) {
    throw unread(e);
  }
  if (!Array.isArray(listed)) {
    throw new Error("GitHub /user/emails answered something other than a list");
  }
  const found = (listed as Listed[]).find(
    (e) => e?.primary === true && e.verified === true,
  );
  const address = found?.email;
  // GitHub's stand-in for a private address takes no mail: not one a person can be reached at
  if (typeof address !== "string" || noreply.test(address)) return null;
  return address;
}
