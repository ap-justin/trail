import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { invite, session } from "./db/schema.js";
import { createBot, revokeKey } from "./service/keys.js";
import { setupTestApp } from "./test-app.js";
import { OTHER_PNG, PNG, WEBP } from "./test-images.js";

const { app, bot, db, request, signIn, owner, addMember } = setupTestApp();

let photoUrl = "";
let memberCookie = "";
let outsiderCookie = "";

const putPhoto = (body: Uint8Array, contentType: string) =>
  app.request("/api/v1/me/photo", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${bot.key}`,
      "content-type": contentType,
    },
    body,
  });

// each test starts from the bot's WEBP photo, whatever the one before did to it
beforeEach(async () => {
  photoUrl = (
    (await (await putPhoto(WEBP, "image/webp")).json()) as {
      photoUrl: string;
    }
  ).photoUrl;
});

beforeAll(async () => {
  await signIn(owner);
  memberCookie = await addMember("member-none", []);
  outsiderCookie = await signIn("outsider");
});

function expectServedWebp(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/webp");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toBe(
    "default-src 'none'; sandbox",
  );
  expect(res.headers.get("cache-control")).toBe(
    "private, max-age=31536000, immutable",
  );
  expect(res.headers.get("content-disposition")).toBe("inline");
}

test("a bot key gets the photo's bytes with its stored type and an immutable cache", async () => {
  const res = await request("GET", photoUrl);
  expectServedWebp(res);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEBP);
});

test("a signed-in member gets the photo, even one seeing no projects", async () => {
  const res = await request("GET", photoUrl, {
    key: null,
    cookie: memberCookie,
  });
  expectServedWebp(res);
});

test("HEAD answers with the same headers", async () => {
  const res = await app.request(photoUrl, {
    method: "HEAD",
    headers: { authorization: `Bearer ${bot.key}` },
  });
  expectServedWebp(res);
});

test.each([
  ["no key or session", null, false],
  ["an unknown key", "trail_00000000_nope", false],
  ["a signed-in account not invited", null, true],
])("%s is a 401 in the shared shape", async (_, key, asOutsider) => {
  const res = await request("GET", photoUrl, {
    key,
    cookie: asOutsider ? outsiderCookie : undefined,
  });
  expect(res.status).toBe(401);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
    "unauthorized",
  );
});

test.each([
  [
    "an unknown actor",
    (_actor: string, hash: string) => `/api/photos/nobody/${hash}`,
  ],
  [
    "a known actor with a wrong hash",
    (actor: string) => `/api/photos/${actor}/stale`,
  ],
])(
  "%s is a 401 with no key or session, not the 404 a signed-in caller gets",
  async (_, urlOf) => {
    const [, , , actor = "", hash = ""] = photoUrl.split("/");
    const url = urlOf(actor, hash);
    expect((await request("GET", url, { key: null })).status).toBe(401);
    expect((await request("GET", url)).status).toBe(404);
  },
);

test("a stale hash, an actor without a photo and an unknown actor are 404s", async () => {
  const stale = photoUrl;
  const replaced = (await (await putPhoto(OTHER_PNG, "image/png")).json()) as {
    photoUrl: string;
  };
  expect((await request("GET", stale)).status).toBe(404);
  expect((await request("GET", replaced.photoUrl)).status).toBe(200);

  const hash = replaced.photoUrl.split("/").at(-1);
  expect((await request("GET", `/api/photos/nobody/${hash}`)).status).toBe(404);
  await request("DELETE", "/api/v1/me/photo");
  const gone = await request("GET", replaced.photoUrl);
  expect(gone.status).toBe(404);
  expect(((await gone.json()) as { error: { code: string } }).error.code).toBe(
    "not_found",
  );
});

const sessionToken = (cookie: string) =>
  decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";

test("a revoked bot key is a 401, though the same key read the photo before", async () => {
  const doomed = createBot(db, "doomed");
  expect((await request("GET", photoUrl, { key: doomed.key })).status).toBe(
    200,
  );
  revokeKey(db, doomed.key.split("_")[1] ?? "");
  expect((await request("GET", photoUrl, { key: doomed.key })).status).toBe(
    401,
  );
});

test("a member removed while their session is live is a 401", async () => {
  const cookie = await addMember("member-removed", []);
  expect((await request("GET", photoUrl, { key: null, cookie })).status).toBe(
    200,
  );
  db.delete(invite).where(eq(invite.username, "member-removed")).run();
  expect((await request("GET", photoUrl, { key: null, cookie })).status).toBe(
    401,
  );
});

test("an expired session is a 401", async () => {
  const cookie = await addMember("member-expired", []);
  expect((await request("GET", photoUrl, { key: null, cookie })).status).toBe(
    200,
  );
  db.update(session)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(session.token, sessionToken(cookie)))
    .run();
  expect((await request("GET", photoUrl, { key: null, cookie })).status).toBe(
    401,
  );
});

/** A fresh member whose session is an hour from expiry, past better-auth's updateAge. */
async function dueSession(login: string) {
  const cookie = await addMember(login, []);
  const token = sessionToken(cookie);
  const dueAt = new Date(Date.now() + 3_600_000);
  dueAt.setMilliseconds(0);
  db.update(session)
    .set({ expiresAt: dueAt })
    .where(eq(session.token, token))
    .run();
  const expiresAt = () =>
    db
      .select({ expiresAt: session.expiresAt })
      .from(session)
      .where(eq(session.token, token))
      .get()?.expiresAt;
  return { cookie, dueAt, expiresAt };
}

test("serving a photo leaves a session due for refresh as it was, and sets no cookie", async () => {
  const { cookie, dueAt, expiresAt } = await dueSession("member-due");
  const res = await request("GET", photoUrl, { key: null, cookie });
  expectServedWebp(res);
  expect(res.headers.getSetCookie()).toEqual([]);
  expect(expiresAt()).toEqual(dueAt);
});

test("a refreshing route does slide the same due session and sets a cookie", async () => {
  const { cookie, dueAt, expiresAt } = await dueSession("member-control");
  const res = await request("GET", "/api/web/me", { key: null, cookie });
  expect(res.status).toBe(200);
  expect(res.headers.getSetCookie()).not.toEqual([]);
  expect(expiresAt()?.getTime()).toBeGreaterThan(dueAt.getTime());
});

test("a PNG-signature file with a script after it is served as an inert image/png", async () => {
  const polyglot = new Uint8Array([
    ...PNG,
    ...Buffer.from("<html><script>alert(1)</script></html>"),
  ]);
  const put = await putPhoto(polyglot, "image/png");
  expect(put.status).toBe(200);
  const { photoUrl: url } = (await put.json()) as { photoUrl: string };
  const res = await request("GET", url);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toBe(
    "default-src 'none'; sandbox",
  );
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(polyglot);
});
