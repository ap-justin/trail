import { expect, test } from "vitest";
import { createBot } from "../service/keys.js";
import { projectKey, setupTestApp } from "../test-app.js";
import {
  JPEG,
  OTHER_PNG,
  PNG,
  pngOfSize,
  SVG,
  TEXT,
  WEBP,
} from "../test-images.js";

const { app, db, bot, request, addBot, addProject } = setupTestApp();
const scopeProject = addProject("scoped");

// biome-ignore lint/suspicious/noExplicitAny: loose response bodies for field reads
type Body = Record<string, any>;

function putPhoto(
  body: Uint8Array,
  contentType: string | null,
  key: string = bot.key,
) {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (contentType !== null) headers["content-type"] = contentType;
  return app.request("/api/v1/me/photo", { method: "PUT", headers, body });
}

const whoami = async (key: string = bot.key) =>
  (await (await request("GET", "/api/v1/whoami", { key })).json()) as Body;

test("a bot sets its photo and whoami returns its URL", async () => {
  const res = await putPhoto(PNG, "image/png");
  expect(res.status).toBe(200);
  const { photoUrl } = (await res.json()) as Body;
  expect(photoUrl).toMatch(
    new RegExp(`^/api/photos/${bot.actor.id}/[0-9a-f]{64}$`),
  );
  expect((await whoami()).photoUrl).toBe(photoUrl);
});

test("a new photo replaces the old one under a new URL, and clearing leaves none", async () => {
  const first = (await (await putPhoto(PNG, "image/png")).json()) as Body;
  const second = (await (
    await putPhoto(OTHER_PNG, "image/png")
  ).json()) as Body;
  expect(second.photoUrl).not.toBe(first.photoUrl);
  expect((await whoami()).photoUrl).toBe(second.photoUrl);

  const cleared = await request("DELETE", "/api/v1/me/photo");
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toEqual({ photoUrl: null });
  expect((await whoami()).photoUrl).toBeNull();

  const again = await request("DELETE", "/api/v1/me/photo");
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual({ photoUrl: null });
});

test("a bot's photo calls leave another bot's photo as it was", async () => {
  const other = addBot("other");
  const mine = addBot("mine");
  const theirs = (
    (await (await putPhoto(WEBP, "image/webp", other.key)).json()) as Body
  ).photoUrl;
  await putPhoto(PNG, "image/png", mine.key);
  expect((await whoami(other.key)).photoUrl).toBe(theirs);
  await request("DELETE", "/api/v1/me/photo", { key: mine.key });
  expect((await whoami(other.key)).photoUrl).toBe(theirs);
});

test("a key limited to reading one project still sets and clears its own photo", async () => {
  const scoped = createBot(db, "reader", {
    scope: { projects: [scopeProject.key], actions: ["read"] },
  });
  const set = await putPhoto(JPEG, "image/jpeg", scoped.key);
  expect(set.status).toBe(200);
  expect((await whoami(scoped.key)).photoUrl).toBe(
    ((await set.json()) as Body).photoUrl,
  );
  const cleared = await request("DELETE", "/api/v1/me/photo", {
    key: scoped.key,
  });
  expect(cleared.status).toBe(200);
});

test("the bots list carries each bot's photo URL, null without one", async () => {
  const pictured = addBot("pictured");
  const plain = addBot("plain");
  const { photoUrl } = (await (
    await putPhoto(PNG, "image/png", pictured.key)
  ).json()) as Body;
  const res = await request("GET", "/api/v1/bots?limit=200");
  const items = ((await res.json()) as Body).items as Body[];
  expect(items.find((b) => b.id === pictured.actor.id)?.photoUrl).toBe(
    photoUrl,
  );
  expect(items.find((b) => b.id === plain.actor.id)?.photoUrl).toBeNull();
});

test("bytes of exactly 256 KB are stored and one byte more is a 413", async () => {
  expect((await putPhoto(pngOfSize(262144), "image/png")).status).toBe(200);
  const res = await putPhoto(pngOfSize(262145), "image/png");
  expect(res.status).toBe(413);
  const { error } = (await res.json()) as Body;
  expect(error.code).toBe("payload_too_large");
  // the limitBody middleware's message, which never saw the body's length; the service's own would say "262145 bytes,"
  expect(error.message).toMatch(/^the photo is over the limit/);
});

test.each([
  ["an SVG", SVG, "image/png"],
  ["a text file labelled image/png", TEXT, "image/png"],
  ["an empty body", new Uint8Array(), "image/png"],
])(
  "%s is a 422 invalid_image that leaves the photo as it was",
  async (_, body, type) => {
    const kept = addBot(`kept-${projectKey()}`);
    const { photoUrl } = (await (
      await putPhoto(PNG, "image/png", kept.key)
    ).json()) as Body;
    const res = await putPhoto(body, type, kept.key);
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as Body;
    expect(error.code).toBe("invalid_image");
    expect(error.message).toMatch(/PNG, JPEG or WebP/);
    expect((await whoami(kept.key)).photoUrl).toBe(photoUrl);
  },
);

test("a JPEG labelled image/png is stored as a JPEG", async () => {
  const res = await putPhoto(JPEG, "image/png");
  expect(res.status).toBe(200);
  const { photoUrl } = (await res.json()) as Body;
  const served = await request("GET", photoUrl);
  expect(served.headers.get("content-type")).toBe("image/jpeg");
});

test.each([
  [
    "application/x-www-form-urlencoded, as curl --data-binary sends it",
    "application/x-www-form-urlencoded",
  ],
  ["application/octet-stream", "application/octet-stream"],
  ["image/jpg", "image/jpg"],
  ["image/gif", "image/gif"],
  ["no Content-Type", null],
])("a PNG sent as %s is stored as a PNG", async (_, type) => {
  const res = await putPhoto(PNG, type);
  expect(res.status).toBe(200);
  const { photoUrl } = (await res.json()) as Body;
  const served = await request("GET", photoUrl);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
});

test.each([
  ["an SVG sent as image/svg+xml", SVG, "image/svg+xml"],
  [
    "a text file sent as application/x-www-form-urlencoded",
    TEXT,
    "application/x-www-form-urlencoded",
  ],
  ["an empty body sent without a Content-Type", new Uint8Array(), null],
])("%s is a 422 invalid_image", async (_, body, type) => {
  const res = await putPhoto(body, type);
  expect(res.status).toBe(422);
  expect(((await res.json()) as Body).error.code).toBe("invalid_image");
});

test("without a key the photo routes are a 401", async () => {
  const set = await app.request("/api/v1/me/photo", {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: PNG,
  });
  expect(set.status).toBe(401);
  expect(
    (await request("DELETE", "/api/v1/me/photo", { key: null })).status,
  ).toBe(401);
});
