import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import { actor, actorPhoto } from "../db/schema.js";
import type { ActorUpdate } from "../events/bus.js";
import { PHOTO_MAX_BYTES } from "../service/photos.js";
import { setupTestApp, TEST_OWNER, TEST_OWNER_ID } from "../test-app.js";
import { JPEG, PNG, pngOfSize, TEXT } from "../test-images.js";

/** How far the auth clock runs ahead of real time; each test starts it level and only moves it forward. */
let ahead = 0;
const HOUR = 3_600_000;

/** What the stubbed avatar fetch answers next; each test sets its own. */
let answer: (init: RequestInit | undefined) => Promise<Response>;
const calls: { url: string; init: RequestInit | undefined }[] = [];
beforeEach(() => {
  ahead = 0;
  calls.length = 0;
  answer = async () => new Response(PNG, { status: 200 });
});

const {
  db,
  bus,
  request,
  signIn,
  signInWithGitHub,
  addMember,
  viewerOf,
  inviteEmail,
  signInWithEmail,
} = setupTestApp({
  avatarFetch: async (input, init) => {
    calls.push({ url: String(input), init });
    return answer(init);
  },
  authNow: () => Date.now() + ahead,
});

const updates: ActorUpdate[] = [];
bus.subscribeActors((update) => updates.push(update));
beforeEach(() => {
  updates.length = 0;
});

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const photoOf = (githubId: number) => {
  const row = db
    .select({
      content: actorPhoto.content,
      contentType: actorPhoto.contentType,
      hash: actorPhoto.hash,
    })
    .from(actorPhoto)
    .innerJoin(actor, eq(actor.id, actorPhoto.actorId))
    .where(eq(actor.githubId, githubId))
    .get();
  return row && { ...row, content: new Uint8Array(row.content) };
};

// sign-in doesn't wait on the photo, so each test waits for the write it checks
const photoLands = (githubId: number, bytes: Uint8Array) =>
  expect
    .poll(() => photoOf(githubId)?.hash, { timeout: 5_000 })
    .toBe(sha256(bytes));

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

/** Resolves once the photo fetch for `login` has failed and been given up on. */
const photoGivenUp = (login: string) =>
  vi.waitFor(
    () =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`GitHub photo for ${login} not stored`),
      ),
    { timeout: 5_000 },
  );

test("the owner's first sign-in stores their GitHub photo", async () => {
  await signIn(TEST_OWNER);
  await photoLands(TEST_OWNER_ID, PNG);
  expect(photoOf(TEST_OWNER_ID)).toEqual({
    content: PNG,
    contentType: "image/png",
    hash: sha256(PNG),
  });
});

test("an invited member's first sign-in stores their GitHub photo", async () => {
  await addMember("lovelace", [], { githubId: 7001 });
  await photoLands(7001, PNG);
});

test("a later sign-in replaces the photo with GitHub's current one", async () => {
  await addMember("babbage", [], { githubId: 7002 });
  await photoLands(7002, PNG);
  answer = async () => new Response(JPEG, { status: 200 });
  await signIn("babbage", { githubId: 7002 });
  await photoLands(7002, JPEG);
  expect(photoOf(7002)).toEqual({
    content: JPEG,
    contentType: "image/jpeg",
    hash: sha256(JPEG),
  });
});

/** A PNG body of 1 MB past the cap that never says how long it is: bounded, so a missing cap can't exhaust memory. */
const CHUNK = 65_536;
let pulled = 0;
const oversizedPng = () => {
  pulled = 0;
  let left = PHOTO_MAX_BYTES + 1_048_576;
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left <= 0) return controller.close();
      const chunk = sent ? new Uint8Array(CHUNK) : PNG;
      sent = true;
      pulled += chunk.length;
      left -= chunk.length;
      controller.enqueue(chunk);
    },
  });
};

// each with its own GitHub account, so a failure follows a stored photo or none
const failures: [string, number, () => Promise<Response>][] = [
  [
    "a network error",
    1,
    async () => Promise.reject(new TypeError("fetch failed")),
  ],
  ["a 500", 2, async () => new Response(JPEG, { status: 500 })],
  [
    "a body over the limit with no content-length",
    3,
    async () => new Response(oversizedPng()),
  ],
  [
    "a declared content-length over the limit",
    4,
    async () => new Response(JPEG, { headers: { "content-length": "262145" } }),
  ],
  ["bytes that are not an image", 5, async () => new Response(TEXT)],
];

test.each(failures)(
  "%s still signs in and keeps the previous photo",
  async (_, n, failure) => {
    const githubId = 7100 + n;
    await addMember(`kept-${n}`, [], { githubId });
    await photoLands(githubId, PNG);
    answer = failure;
    const { cookie } = await signInWithGitHub({
      id: githubId,
      login: `kept-${n}`,
      name: null,
    });
    expect(await viewerOf(cookie)).toMatchObject({ kind: "member" });
    await photoGivenUp(`kept-${n}`);
    expect(photoOf(githubId)?.content).toEqual(PNG);
  },
);

test.each(failures)(
  "%s on a first sign-in leaves no photo",
  async (_, n, failure) => {
    const githubId = 7200 + n;
    answer = failure;
    await addMember(`bare-${n}`, [], { githubId });
    await photoGivenUp(`bare-${n}`);
    expect(photoOf(githubId)).toBeUndefined();
  },
);

test("an oversized body with no content-length is read only up to the cap, not to its end", async () => {
  answer = async () => new Response(oversizedPng());
  await addMember("flooded", [], { githubId: 7900 });
  await photoGivenUp("flooded");
  // the stream holds 1 MB past the cap; slack covers chunks queued ahead of the reader
  expect(pulled).toBeGreaterThan(PHOTO_MAX_BYTES);
  expect(pulled).toBeLessThanOrEqual(PHOTO_MAX_BYTES + 3 * CHUNK);
  expect(photoOf(7900)).toBeUndefined();
});

test("a redirect from GitHub's photo host is refused: sign-in goes on and the previous photo stays", async () => {
  // Node's own fetch against local servers, so the redirect is followed or refused by the real thing
  const elsewhere = createServer((_, res) => res.end(JPEG));
  const avatars = createServer((_, res) => {
    const { port } = elsewhere.address() as AddressInfo;
    res.writeHead(302, { location: `http://127.0.0.1:${port}/photo.jpg` });
    res.end();
  });
  for (const server of [elsewhere, avatars]) {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  }
  try {
    await addMember("redirected", [], { githubId: 7800 });
    await photoLands(7800, PNG);
    const { port } = avatars.address() as AddressInfo;
    answer = (init) => fetch(`http://127.0.0.1:${port}/u/7800`, init);
    const { cookie } = await signInWithGitHub({
      id: 7800,
      login: "redirected",
      name: null,
    });
    expect(await viewerOf(cookie)).toMatchObject({ kind: "member" });
    await photoGivenUp("redirected");
    expect(photoOf(7800)?.content).toEqual(PNG);
  } finally {
    for (const server of [elsewhere, avatars]) server.close();
  }
});

test("sign-in asks GitHub for the account's photo by its numeric id, sending no cookie or credential", async () => {
  await addMember("curie", [], { githubId: 7400 });
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  const [{ url, init }] = calls as [(typeof calls)[number]];
  expect(url).toBe("https://avatars.githubusercontent.com/u/7400?s=128");
  expect([...new Request(url, init).headers]).toEqual([]);
});

test("a not-invited account's sign-in fetches and stores no photo", async () => {
  const { cookie } = await signInWithGitHub({
    id: 7500,
    login: "uninvited",
    name: null,
  });
  expect(await viewerOf(cookie)).toMatchObject({ kind: "not_invited" });
  // control: an invited sign-in after it does fetch, and by the time its photo lands the uninvited one's fetch would have started too
  await addMember("invited-after", [], { githubId: 7501 });
  await photoLands(7501, PNG);
  expect(calls.map((c) => c.url)).toEqual([
    "https://avatars.githubusercontent.com/u/7501?s=128",
  ]);
  expect(photoOf(7500)).toBeUndefined();
});

test("sign-in returns while GitHub's photo is still on its way, and the photo lands after", async () => {
  let release = () => {};
  answer = (init) =>
    new Promise((resolve, reject) => {
      release = () => resolve(new Response(PNG, { status: 200 }));
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  // were sign-in to await the fetch, this would hang until the test times out
  await addMember("hopper", [], { githubId: 7700 });
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(photoOf(7700)).toBeUndefined();
  release();
  await photoLands(7700, PNG);
});

test("a GitHub that never answers is given up on once the fetch's timeout fires", async () => {
  // AbortSignal.timeout runs on Node's own timer, out of fake timers' reach: hand out signals the test fires itself
  const timeouts = new Map<AbortSignal, { ms: number; fire: () => void }>();
  const timeoutSpy = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) => {
      const controller = new AbortController();
      timeouts.set(controller.signal, {
        ms,
        fire: () =>
          controller.abort(new DOMException("timed out", "TimeoutError")),
      });
      return controller.signal;
    });
  try {
    // as fetch does, the stub gives up when the signal it was handed aborts
    answer = (init) =>
      new Promise((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    await addMember("patient", [], { githubId: 7600 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const timeout = timeouts.get(calls[0]?.init?.signal as AbortSignal);
    // the fetch carries a short timeout (AVATAR_TIMEOUT_MS in avatar.ts, 3s), and nothing has given up before it fires
    expect(timeout?.ms).toBeGreaterThanOrEqual(1_000);
    expect(timeout?.ms).toBeLessThanOrEqual(3_000);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("patient"));

    timeout?.fire();
    await photoGivenUp("patient");
    expect(photoOf(7600)).toBeUndefined();
  } finally {
    timeoutSpy.mockRestore();
  }
});

test.each([
  [
    "declared content-length",
    7950,
    () =>
      new Response(pngOfSize(PHOTO_MAX_BYTES), {
        headers: { "content-length": String(PHOTO_MAX_BYTES) },
      }),
  ],
  ["no content-length", 7953, () => new Response(pngOfSize(PHOTO_MAX_BYTES))],
])(
  "a photo of exactly the limit with %s is stored",
  async (_, githubId, make) => {
    answer = async () => make();
    await addMember(`edge-${githubId}`, [], { githubId });
    await photoLands(githubId, pngOfSize(PHOTO_MAX_BYTES));
  },
);

/** A body that records whether the consumer gave up on it. */
const watchedBody = (chunks: Uint8Array[]) => {
  const watch = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      watch.cancelled = true;
    },
  });
  return { watch, body };
};

// the service refuses these bytes too, so only the body's fate shows which stage did the refusing
test("a declared content-length one byte over the limit is refused without reading the body", async () => {
  // the body itself is a small valid PNG: read, it would be stored
  const { watch, body } = watchedBody([PNG]);
  answer = async () =>
    new Response(body, {
      headers: { "content-length": String(PHOTO_MAX_BYTES + 1) },
    });
  await addMember("over-declared", [], { githubId: 7951 });
  await photoGivenUp("over-declared");
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining(`is ${PHOTO_MAX_BYTES + 1} bytes`),
  );
  expect(watch.cancelled).toBe(true);
  expect(photoOf(7951)).toBeUndefined();
});

test("a streamed body one byte over the limit is abandoned when the cap trips", async () => {
  const { watch, body } = watchedBody([
    pngOfSize(PHOTO_MAX_BYTES),
    new Uint8Array(1),
    new Uint8Array(CHUNK),
  ]);
  answer = async () => new Response(body);
  await addMember("over-streamed", [], { githubId: 7952 });
  await photoGivenUp("over-streamed");
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining(`over ${PHOTO_MAX_BYTES} bytes`),
  );
  expect(watch.cancelled).toBe(true);
  expect(photoOf(7952)).toBeUndefined();
});

test("a body that stalls after the headers is abandoned when the timeout fires, and sign-in succeeds", async () => {
  // as the timeout test above: signals the test fires itself, since AbortSignal.timeout is out of fake timers' reach
  const fires = new Map<AbortSignal, () => void>();
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController();
    fires.set(controller.signal, () =>
      controller.abort(new DOMException("timed out", "TimeoutError")),
    );
    return controller.signal;
  });
  try {
    // as fetch does, the body stream errors when the signal it was handed aborts
    answer = async (init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(PNG);
            const signal = init?.signal;
            signal?.addEventListener("abort", () =>
              controller.error(signal.reason),
            );
          },
        }),
        { status: 200 },
      );
    // addMember signs the member in: it returning is sign-in succeeding while the body hangs
    await addMember("stalled", [], { githubId: 7960 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("stalled"));
    fires.get(calls[0]?.init?.signal as AbortSignal)?.();
    await photoGivenUp("stalled");
    expect(photoOf(7960)).toBeUndefined();
  } finally {
    timeoutSpy.mockRestore();
  }
});

/** The actor of the GitHub account, by its numeric id. */
const actorIdOf = (githubId: number) =>
  db
    .select({ id: actor.id })
    .from(actor)
    .where(eq(actor.githubId, githubId))
    .get()?.id ?? "";

const photoCheckedAt = (githubId: number) =>
  db
    .select({ updatedAt: actorPhoto.updatedAt })
    .from(actorPhoto)
    .where(eq(actorPhoto.actorId, actorIdOf(githubId)))
    .get()?.updatedAt;

/** Backdates the photo's last check by `hours`, as if that long had passed since. */
const ageThePhoto = (githubId: number, hours: number) =>
  db
    .update(actorPhoto)
    .set({ updatedAt: new Date(Date.now() - hours * HOUR) })
    .where(eq(actorPhoto.actorId, actorIdOf(githubId)))
    .run();

/** A page of the app loading for this session: the SPA's first call. */
const loadApp = (cookie: string) =>
  request("GET", "/api/web/me", { cookie, key: null });

/**
 * A member signed in with GitHub's PNG stored, more than an hour ago by the
 * auth clock, whose photo was last checked `hours` ago; the fetch log cleared.
 */
async function memberWithPhoto(login: string, githubId: number, hours = 25) {
  const cookie = await addMember(login, [], { githubId });
  await photoLands(githubId, PNG);
  ageThePhoto(githubId, hours);
  ahead += 2 * HOUR;
  calls.length = 0;
  updates.length = 0;
  return cookie;
}

const photoPath = (githubId: number, bytes: Uint8Array) =>
  `/api/photos/${actorIdOf(githubId)}/${sha256(bytes)}`;

test("a photo last checked over a day ago is fetched again when the app loads, published once and served at its new URL", async () => {
  const cookie = await memberWithPhoto("stale", 8001);
  answer = async () => new Response(JPEG, { status: 200 });
  expect((await loadApp(cookie)).status).toBe(200);
  await photoLands(8001, JPEG);
  expect(calls.map((c) => c.url)).toEqual([
    "https://avatars.githubusercontent.com/u/8001?s=128",
  ]);
  expect(updates).toEqual([
    { actorId: actorIdOf(8001), photoUrl: photoPath(8001, JPEG) },
  ]);
  const me = (await (await loadApp(cookie)).json()) as {
    actor: { photoUrl: string };
  };
  expect(me.actor.photoUrl).toBe(photoPath(8001, JPEG));
  const served = await request("GET", photoPath(8001, JPEG), {
    cookie,
    key: null,
  });
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(JPEG);
});

test("the same bytes again publish nothing but mark the photo checked", async () => {
  const cookie = await memberWithPhoto("unchanged", 8002);
  const before = photoCheckedAt(8002)?.getTime() ?? 0;
  await loadApp(cookie);
  await vi.waitFor(() =>
    expect(photoCheckedAt(8002)?.getTime()).toBeGreaterThan(before + HOUR),
  );
  expect(calls).toHaveLength(1);
  expect(updates).toEqual([]);
  expect(photoOf(8002)?.content).toEqual(PNG);
});

test("a photo checked within the day is not fetched when the app loads", async () => {
  const cookie = await memberWithPhoto("fresh", 8003, 20);
  expect((await loadApp(cookie)).status).toBe(200);
  expect(calls).toEqual([]);
});

test("the app loading again within the hour fetches nothing more, even after a failed fetch, and after the hour fetches again", async () => {
  const cookie = await memberWithPhoto("retried", 8004);
  answer = async () => new Response(null, { status: 500 });
  await loadApp(cookie);
  await photoGivenUp("retried");
  ahead += HOUR - 60_000;
  await loadApp(cookie);
  expect(calls).toHaveLength(1);
  ahead += 2 * 60_000;
  answer = async () => new Response(JPEG, { status: 200 });
  await loadApp(cookie);
  await photoLands(8004, JPEG);
  expect(calls).toHaveLength(2);
});

test("a person without a photo is fetched for at most hourly", async () => {
  answer = async () => new Response(TEXT);
  const cookie = await addMember("photoless", [], { githubId: 8005 });
  await photoGivenUp("photoless");
  // sign-in's own fetch counts: the load right after it fetches nothing
  await loadApp(cookie);
  expect(calls).toHaveLength(1);
  ahead += 2 * HOUR;
  await loadApp(cookie);
  await loadApp(cookie);
  expect(calls).toHaveLength(2);
});

test.each(failures)(
  "%s on a refresh keeps the photo and publishes nothing",
  async (_, n, failure) => {
    const githubId = 8100 + n;
    const cookie = await memberWithPhoto(`refresh-kept-${n}`, githubId);
    answer = failure;
    expect((await loadApp(cookie)).status).toBe(200);
    await photoGivenUp(`refresh-kept-${n}`);
    expect(photoOf(githubId)?.content).toEqual(PNG);
    expect(updates).toEqual([]);
  },
);

test("a redirect on a refresh is refused and the photo stays", async () => {
  const elsewhere = createServer((_, res) => res.end(JPEG));
  const avatars = createServer((_, res) => {
    const { port } = elsewhere.address() as AddressInfo;
    res.writeHead(302, { location: `http://127.0.0.1:${port}/photo.jpg` });
    res.end();
  });
  for (const server of [elsewhere, avatars]) {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  }
  try {
    const cookie = await memberWithPhoto("refresh-redirected", 8200);
    const { port } = avatars.address() as AddressInfo;
    answer = (init) => fetch(`http://127.0.0.1:${port}/u/8200`, init);
    await loadApp(cookie);
    await photoGivenUp("refresh-redirected");
    expect(photoOf(8200)?.content).toEqual(PNG);
    expect(updates).toEqual([]);
  } finally {
    for (const server of [elsewhere, avatars]) server.close();
  }
});

test("a refresh asks with redirects refused and a short timeout, is answered without waiting on it, and gives up when the timeout fires", async () => {
  const timeouts = new Map<AbortSignal, { ms: number; fire: () => void }>();
  const timeoutSpy = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) => {
      const controller = new AbortController();
      timeouts.set(controller.signal, {
        ms,
        fire: () =>
          controller.abort(new DOMException("timed out", "TimeoutError")),
      });
      return controller.signal;
    });
  try {
    const cookie = await memberWithPhoto("refresh-slow", 8201);
    answer = (init) =>
      new Promise((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    // were the load to await the fetch, this would hang until the test times out
    expect((await loadApp(cookie)).status).toBe(200);
    const [{ init }] = calls as [(typeof calls)[number]];
    expect(init?.redirect).toBe("error");
    const timeout = timeouts.get(init?.signal as AbortSignal);
    expect(timeout?.ms).toBeGreaterThanOrEqual(1_000);
    expect(timeout?.ms).toBeLessThanOrEqual(3_000);
    timeout?.fire();
    await photoGivenUp("refresh-slow");
    expect(photoOf(8201)?.content).toEqual(PNG);
    expect(updates).toEqual([]);
  } finally {
    timeoutSpy.mockRestore();
  }
});

test("a slow refresh lands after the load was answered", async () => {
  const cookie = await memberWithPhoto("refresh-later", 8202);
  let release = () => {};
  answer = () =>
    new Promise((resolve) => {
      release = () => resolve(new Response(JPEG, { status: 200 }));
    });
  expect((await loadApp(cookie)).status).toBe(200);
  expect(photoOf(8202)?.content).toEqual(PNG);
  release();
  await photoLands(8202, JPEG);
});

test("a person signed in by email, and an anonymous viewer, never fetch a photo", async () => {
  inviteEmail("ada@example.test");
  const cookie = await signInWithEmail("ada@example.test");
  ahead += 2 * HOUR;
  const me = (await (await loadApp(cookie)).json()) as { state: string };
  expect(me.state).toBe("member");
  expect((await request("GET", "/api/web/me", { key: null })).status).toBe(200);
  expect(calls).toEqual([]);
});

test("reading the viewer for a stream or a photo fetches nothing", async () => {
  const cookie = await memberWithPhoto("heartbeat", 8203);
  expect(await viewerOf(cookie)).toMatchObject({ kind: "member" });
  await request("GET", photoPath(8203, PNG), { cookie, key: null });
  expect(calls).toEqual([]);
});

test("a sign-in that changes the photo publishes it; one with the same bytes does not", async () => {
  await addMember("signing", [], { githubId: 8204 });
  await photoLands(8204, PNG);
  await vi.waitFor(() =>
    expect(updates).toEqual([
      { actorId: actorIdOf(8204), photoUrl: photoPath(8204, PNG) },
    ]),
  );
  await signIn("signing", { githubId: 8204 });
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  answer = async () => new Response(JPEG, { status: 200 });
  await signIn("signing", { githubId: 8204 });
  await photoLands(8204, JPEG);
  expect(updates).toEqual([
    { actorId: actorIdOf(8204), photoUrl: photoPath(8204, PNG) },
    { actorId: actorIdOf(8204), photoUrl: photoPath(8204, JPEG) },
  ]);
});
