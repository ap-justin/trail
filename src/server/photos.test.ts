import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, expect, test } from "vitest";
import { session } from "./db/schema.js";
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

/** A fresh member whose session is an hour from expiry, past better-auth's updateAge. */
async function dueSession(login: string) {
  const cookie = await addMember(login, []);
  const token =
    decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0] ?? "";
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
