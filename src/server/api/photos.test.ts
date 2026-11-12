import { expect, test } from "vitest";
import { createBot, revokeKey } from "../service/keys.js";
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

const { app, db, bot, request, addBot, addProject, owner, signIn } =
  setupTestApp();
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
  const { photoUrl } = (await set.json()) as Body;
  expect((await whoami(scoped.key)).photoUrl).toBe(photoUrl);
  const served = await request("GET", photoUrl, { key: scoped.key });
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(JPEG);
  const cleared = await request("DELETE", "/api/v1/me/photo", {
    key: scoped.key,
  });
  expect(cleared.status).toBe(200);
  expect((await whoami(scoped.key)).photoUrl).toBeNull();
});

test("a key without the read action still sets and clears its own photo", async () => {
  const writer = createBot(db, "writer", {
    scope: { actions: ["comments"] },
  });
  const set = await putPhoto(PNG, "image/png", writer.key);
  expect(set.status).toBe(200);
  const { photoUrl } = (await set.json()) as Body;
  expect((await whoami(writer.key)).photoUrl).toBe(photoUrl);
  const cleared = await request("DELETE", "/api/v1/me/photo", {
    key: writer.key,
  });
  expect(cleared.status).toBe(200);
  expect((await whoami(writer.key)).photoUrl).toBeNull();
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
  ["an SVG sent as image/svg+xml", SVG, "image/svg+xml"],
  ["a text file labelled image/png", TEXT, "image/png"],
  [
    "a text file sent as application/x-www-form-urlencoded",
    TEXT,
    "application/x-www-form-urlencoded",
  ],
  ["an empty body", new Uint8Array(), "image/png"],
  ["an empty body sent without a Content-Type", new Uint8Array(), null],
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

test("a PNG uploaded as a multipart form is a 422 asking for the raw bytes, and nothing is stored", async () => {
  const kept = addBot(`form-${projectKey()}`);
  const { photoUrl } = (await (
    await putPhoto(PNG, "image/png", kept.key)
  ).json()) as Body;
  const form = new FormData();
  form.append("photo", new Blob([OTHER_PNG], { type: "image/png" }), "me.png");
  const res = await app.request("/api/v1/me/photo", {
    method: "PUT",
    headers: { authorization: `Bearer ${kept.key}` },
    body: form,
  });
  expect(res.status).toBe(422);
  const { error } = (await res.json()) as Body;
  expect(error.code).toBe("invalid_image");
  expect(error.message).toMatch(/raw bytes/);
  expect(error.message).not.toMatch(/convert/);
  expect((await whoami(kept.key)).photoUrl).toBe(photoUrl);
});

test("a PNG stripped of its line breaks, as curl -d sends it, is a 422 naming --data-binary, and nothing is stored", async () => {
  const kept = addBot(`dash-d-${projectKey()}`);
  const { photoUrl } = (await (
    await putPhoto(PNG, "image/png", kept.key)
  ).json()) as Body;
  const stripped = OTHER_PNG.filter((b) => b !== 0x0a && b !== 0x0d);
  const res = await putPhoto(
    stripped,
    "application/x-www-form-urlencoded",
    kept.key,
  );
  expect(res.status).toBe(422);
  const { error } = (await res.json()) as Body;
  expect(error.code).toBe("invalid_image");
  expect(error.message).toMatch(/curl -d strips line breaks/);
  expect(error.message).toMatch(/--data-binary @/);
  expect((await whoami(kept.key)).photoUrl).toBe(photoUrl);
});

const encoder = new TextEncoder();
const base64Png = Buffer.from(OTHER_PNG).toString("base64");
test.each([
  [
    "set_my_photo's JSON shape",
    JSON.stringify({ data: base64Png }),
    "application/json",
  ],
  [
    "JSON with a charset",
    JSON.stringify({ data: base64Png }),
    "application/json; charset=utf-8",
  ],
  ["base64 text", base64Png, "text/plain"],
  [
    "base64 wrapped at 76 columns, as `base64 me.png` prints it",
    `${base64Png.match(/.{1,76}/g)?.join("\n")}\n`,
    "application/octet-stream",
  ],
  [
    "URL-safe base64",
    base64Png.replaceAll("+", "-").replaceAll("/", "_"),
    "text/plain",
  ],
  ["a data: URL", `data:image/png;base64,${base64Png}`, "text/plain"],
  [
    "base64 posted with curl -d",
    base64Png,
    "application/x-www-form-urlencoded",
  ],
])(
  "a PNG sent as %s is a 422 asking for the raw bytes and naming set_my_photo, and nothing is stored",
  async (_, body, type) => {
    const kept = addBot(`encoded-${projectKey()}`);
    const { photoUrl } = (await (
      await putPhoto(PNG, "image/png", kept.key)
    ).json()) as Body;
    const res = await putPhoto(encoder.encode(body), type, kept.key);
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as Body;
    expect(error.code).toBe("invalid_image");
    expect(error.message).toMatch(/raw bytes/);
    expect(error.message).toMatch(/not JSON or base64/);
    expect(error.message).toMatch(/set_my_photo/);
    expect(error.message).not.toMatch(/convert|curl -d/);
    expect((await whoami(kept.key)).photoUrl).toBe(photoUrl);
  },
);

// 10 bytes of JPEG would base64 to 14 characters plus padding; real files are longer
const LONG_JPEG = new Uint8Array([...JPEG, ...new Uint8Array(20).fill(0x41)]);
test.each([
  ["a WebP", WEBP],
  ["a JPEG", LONG_JPEG],
])(
  "%s sent as base64 text is a 422 asking for the raw bytes and naming set_my_photo, and nothing is stored",
  async (_, image) => {
    const kept = addBot(`b64-${projectKey()}`);
    const { photoUrl } = (await (
      await putPhoto(PNG, "image/png", kept.key)
    ).json()) as Body;
    const text = Buffer.from(image).toString("base64");
    for (const body of [text, `data:image/x;base64,${text}`]) {
      const res = await putPhoto(encoder.encode(body), "text/plain", kept.key);
      expect(res.status).toBe(422);
      const { error } = (await res.json()) as Body;
      expect(error.code).toBe("invalid_image");
      expect(error.message).toMatch(/not JSON or base64/);
      expect(error.message).toMatch(/set_my_photo/);
    }
    expect((await whoami(kept.key)).photoUrl).toBe(photoUrl);
  },
);

test("a raw PNG labelled multipart/form-data is refused as a form, not stored", async () => {
  const kept = addBot(`raw-form-${projectKey()}`);
  const res = await putPhoto(PNG, "multipart/form-data; boundary=x", kept.key);
  expect(res.status).toBe(422);
  const { error } = (await res.json()) as Body;
  expect(error.code).toBe("invalid_image");
  expect(error.message).toMatch(/multipart form/);
  expect((await whoami(kept.key)).photoUrl).toBeNull();
});

test("text sent with no form Content-Type is refused without the curl -d hint", async () => {
  const res = await putPhoto(TEXT, "application/octet-stream");
  expect(res.status).toBe(422);
  const { error } = (await res.json()) as Body;
  expect(error.message).toMatch(/not a PNG, JPEG or WebP/);
  expect(error.message).not.toMatch(/curl -d/);
});

test("a PUT streamed without a Content-Length over the limit is a 413", async () => {
  const body = pngOfSize(262145);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < body.length; i += 65536)
        controller.enqueue(body.slice(i, i + 65536));
      controller.close();
    },
  });
  const res = await app.request("/api/v1/me/photo", {
    method: "PUT",
    headers: {
      authorization: `Bearer ${bot.key}`,
      "content-type": "image/png",
    },
    body: stream,
    duplex: "half",
  });
  expect(res.status).toBe(413);
  const { error } = (await res.json()) as Body;
  expect(error.code).toBe("payload_too_large");
  // the middleware's wording, so the stream was counted rather than decoded by the service
  expect(error.message).toMatch(/^the photo is over the limit/);
});

test("a PUT declaring a Content-Length over the limit is a 413 before its body is read", async () => {
  const kept = addBot(`declared-${projectKey()}`);
  const put = (declared: number, body: Uint8Array) =>
    app.request("/api/v1/me/photo", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${kept.key}`,
        "content-type": "image/png",
        "content-length": String(declared),
      },
      body,
    });
  // control: a declared length at the limit gets through the same way
  expect((await put(262144, pngOfSize(262144))).status).toBe(200);
  // a small valid PNG would be stored if the body were looked at; only the declared length can refuse it
  const res = await put(262145, PNG);
  expect(res.status).toBe(413);
  const { error } = (await res.json()) as Body;
  expect(error.code).toBe("payload_too_large");
  expect(error.message).toMatch(/^the photo is over the limit/);
});

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
  ["application/json", "application/json"],
  ["application/vnd.api+json", "application/vnd.api+json"],
  ["no Content-Type", null],
])("a PNG sent as %s is stored as a PNG", async (_, type) => {
  const res = await putPhoto(PNG, type);
  expect(res.status).toBe(200);
  const { photoUrl } = (await res.json()) as Body;
  const served = await request("GET", photoUrl);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
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

test("an over-limit upload from a missing or revoked key is a 401, not a 413", async () => {
  const revoked = createBot(db, "revoked");
  revokeKey(db, revoked.key.split("_")[1] as string);
  const big = pngOfSize(262145);
  const anonymous = await app.request("/api/v1/me/photo", {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: big,
  });
  expect(anonymous.status).toBe(401);
  expect((await putPhoto(big, "image/png", revoked.key)).status).toBe(401);
  // the same body from a live key reaches the limit, so the 401s above are the key check's
  expect((await putPhoto(big, "image/png")).status).toBe(413);
});

test("a signed-in person cannot set or clear a photo", async () => {
  const cookie = await signIn(owner);
  const set = await app.request("/api/v1/me/photo", {
    method: "PUT",
    headers: { cookie, "content-type": "image/png" },
    body: PNG,
  });
  expect(set.status).toBe(401);
  const clear = await request("DELETE", "/api/v1/me/photo", {
    key: null,
    cookie,
  });
  expect(clear.status).toBe(401);
});
