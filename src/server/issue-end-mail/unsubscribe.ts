import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { escapeHtml } from "../auth/mail.js";
import type { Db } from "../db/client.js";
import { actor } from "../db/schema.js";

/**
 * Signs unsubscribe links, derived from BETTER_AUTH_SECRET as the webhook
 * secrets' key is, under its own label. Changing BETTER_AUTH_SECRET breaks the
 * links in emails already sent.
 */
export type UnsubscribeKey = Buffer;

export function deriveUnsubscribeKey(serverSecret: string): UnsubscribeKey {
  return Buffer.from(
    hkdfSync(
      "sha256",
      serverSecret,
      "trail",
      "trail issue-ended email unsubscribe v1",
      32,
    ),
  );
}

const PATH = "/unsubscribe/issue-end";

const tokenOf = (key: UnsubscribeKey, personId: string) =>
  createHmac("sha256", key).update(personId).digest("base64url");

const pathFor = (key: UnsubscribeKey, personId: string) =>
  `${PATH}?${new URLSearchParams({ person: personId, token: tokenOf(key, personId) })}`;

/** The link that turns off the issue-ended email for `personId`, on `publicUrl`. */
export function unsubscribeUrl(
  publicUrl: string,
  key: UnsubscribeKey,
  personId: string,
): string {
  return `${publicUrl.replace(/\/+$/, "")}${pathFor(key, personId)}`;
}

/** The person the link's token was signed for, or null. */
function signedPerson(
  key: UnsubscribeKey,
  personId: string | undefined,
  token: string | undefined,
): string | null {
  if (!personId || !token) return null;
  const expected = Buffer.from(tokenOf(key, personId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? personId
    : null;
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body>
<h1>${title}</h1>
${body}
</body></html>
`;

const badLink = page(
  "This link doesn't work",
  "<p>Use the stop link in the latest email trail sent you.</p>",
);

// no script, no style, no subresource; the token in the URL is sent nowhere
const headers = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    formAction: ["'self'"],
    baseUri: ["'none'"],
    frameAncestors: ["'none'"],
  },
  referrerPolicy: "no-referrer",
  xFrameOptions: "DENY",
});

/**
 * The issue-ended email's unsubscribe link, no session needed: the link's
 * signed token is the authority. GET only shows a button, since mail scanners
 * open links; POST, from that button or a mail client's RFC 8058 one-click,
 * turns the emails off.
 */
export function unsubscribeRoutes({
  db,
  key,
}: {
  db: Db;
  key: UnsubscribeKey;
}) {
  const app = new Hono();
  app.use(PATH, headers, async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  const personOf = (url: string) => {
    const query = new URL(url).searchParams;
    return signedPerson(
      key,
      query.get("person") ?? undefined,
      query.get("token") ?? undefined,
    );
  };
  app.get(PATH, (c) => {
    const person = personOf(c.req.url);
    if (person === null) return c.html(badLink, 400);
    return c.html(
      page(
        "Stop issue emails?",
        `<p>trail emails you once when an issue filed for you is done or canceled. Stop these emails? Nothing else changes.</p>
<form method="post" action="${escapeHtml(pathFor(key, person))}"><button type="submit">Stop these emails</button></form>`,
      ),
    );
  });
  app.post(PATH, (c) => {
    const person = personOf(c.req.url);
    if (person === null) return c.html(badLink, 400);
    db.update(actor)
      .set({ issueEndMailOff: true })
      .where(and(eq(actor.id, person), eq(actor.kind, "human")))
      .run();
    return c.html(
      page(
        "Unsubscribed",
        "<p>You won't get these emails again. Issues filed for you still show in trail.</p>",
      ),
    );
  });
  return app;
}
