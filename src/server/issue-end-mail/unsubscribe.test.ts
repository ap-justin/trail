import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { actor } from "../db/schema.js";
import { setupTestApp, TEST_ORIGIN, testAuthConfig } from "../test-app.js";
import { deriveUnsubscribeKey, unsubscribeUrl } from "./unsubscribe.js";

const { app, db, inviteEmail, signInWithEmail } = setupTestApp();

const key = deriveUnsubscribeKey(testAuthConfig.BETTER_AUTH_SECRET);

async function person(email: string) {
  inviteEmail(email);
  await signInWithEmail(email);
  const row = db.select().from(actor).where(eq(actor.email, email)).get();
  if (!row) throw new Error(`no actor for ${email}`);
  return row.id;
}

const isOff = (id: string) =>
  db
    .select({ off: actor.issueEndMailOff })
    .from(actor)
    .where(eq(actor.id, id))
    .get()?.off;

test("GET shows a page whose button posts back to the same link, and changes nothing", async () => {
  const id = await person("gus.get@example.com");
  const link = unsubscribeUrl(TEST_ORIGIN, key, id);
  const res = await app.request(link);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  expect(res.headers.get("content-security-policy")).toContain(
    "default-src 'none'",
  );
  const page = await res.text();
  const path = new URL(link);
  expect(page).toContain(
    `<form method="post" action="${`${path.pathname}${path.search}`.replaceAll("&", "&amp;")}">`,
  );
  expect(page).not.toMatch(/<script|style=/i);
  expect(page).toContain("<h1>Stop issue emails?</h1>");
  expect(page).toContain(
    "<p>trail emails you when an issue filed for you is done or canceled. Nothing else changes.</p>",
  );
  expect(page).toContain(">Stop these emails</button>");
  expect(isOff(id)).toBe(false);
});

test("POST from the page's form turns the emails off, and again is still fine", async () => {
  const id = await person("pia.post@example.com");
  const link = unsubscribeUrl(TEST_ORIGIN, key, id);
  for (let i = 0; i < 2; i++) {
    const res = await app.request(link, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<h1>Unsubscribed</h1>");
    expect(page).toContain(
      "<p>You won't get these emails again. Issues filed for you still show in trail.</p>",
    );
    expect(isOff(id)).toBe(true);
  }
});

test("a mail client's RFC 8058 one-click POST turns the emails off", async () => {
  const id = await person("oli.oneclick@example.com");
  const res = await app.request(unsubscribeUrl(TEST_ORIGIN, key, id), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  expect(res.status).toBe(200);
  expect(isOff(id)).toBe(true);
});

test("a missing, forged or another person's token is a plain 400 page, on GET and POST, changing nothing", async () => {
  const id = await person("bea.bad@example.com");
  const other = await person("cal.other@example.com");
  const otherToken = new URL(
    unsubscribeUrl(TEST_ORIGIN, key, other),
  ).searchParams.get("token");
  const forgedKey = deriveUnsubscribeKey(
    "another-secret-of-at-least-32-chars!!",
  );
  for (const path of [
    "/unsubscribe/issue-end",
    `/unsubscribe/issue-end?person=${id}`,
    `/unsubscribe/issue-end?person=${id}&token=nope`,
    `/unsubscribe/issue-end?person=${id}&token=${otherToken}`,
    new URL(unsubscribeUrl(TEST_ORIGIN, forgedKey, id)).pathname +
      new URL(unsubscribeUrl(TEST_ORIGIN, forgedKey, id)).search,
  ]) {
    for (const method of ["GET", "POST"]) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expect(await res.text()).toContain("This link doesn't work");
    }
  }
  expect(isOff(id)).toBe(false);
});
