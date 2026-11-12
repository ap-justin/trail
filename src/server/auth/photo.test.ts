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
import { PHOTO_MAX_BYTES } from "../service/photos.js";
import { setupTestApp, TEST_OWNER, TEST_OWNER_ID } from "../test-app.js";
import { JPEG, PNG, TEXT } from "../test-images.js";

/** What the stubbed avatar fetch answers next; each test sets its own. */
let answer: (init: RequestInit | undefined) => Promise<Response>;
const calls: { url: string; init: RequestInit | undefined }[] = [];
beforeEach(() => {
  calls.length = 0;
  answer = async () => new Response(PNG, { status: 200 });
});

const { db, signIn, signInWithGitHub, addMember, viewerOf } = setupTestApp({
  avatarFetch: async (input, init) => {
    calls.push({ url: String(input), init });
    return answer(init);
  },
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
    const timeout = timeouts.get(calls[0]?.init?.signal as AbortSignal);
    // the fetch carries a finite timeout, and nothing has given up before it fires
    expect(timeout?.ms).toBeGreaterThan(0);
    expect(timeout?.ms).toBeLessThanOrEqual(10_000);
    expect(warn).not.toHaveBeenCalled();

    timeout?.fire();
    await photoGivenUp("patient");
    expect(photoOf(7600)).toBeUndefined();
  } finally {
    timeoutSpy.mockRestore();
  }
});
