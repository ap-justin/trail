import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, expect, test } from "vitest";
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

test("the owner's first sign-in stores their GitHub photo", async () => {
  await signIn(TEST_OWNER);
  expect(photoOf(TEST_OWNER_ID)).toEqual({
    content: PNG,
    contentType: "image/png",
    hash: sha256(PNG),
  });
});

test("an invited member's first sign-in stores their GitHub photo", async () => {
  await addMember("lovelace", [], { githubId: 7001 });
  expect(photoOf(7001)?.hash).toBe(sha256(PNG));
});

test("a later sign-in replaces the photo with GitHub's current one", async () => {
  await addMember("babbage", [], { githubId: 7002 });
  answer = async () => new Response(JPEG, { status: 200 });
  await signIn("babbage", { githubId: 7002 });
  expect(photoOf(7002)).toEqual({
    content: JPEG,
    contentType: "image/jpeg",
    hash: sha256(JPEG),
  });
});

/** A PNG body of 1 MB past the cap that never says how long it is: bounded, so a missing cap can't exhaust memory. */
const oversizedPng = () => {
  let left = PHOTO_MAX_BYTES + 1_048_576;
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left <= 0) return controller.close();
      const chunk = sent ? new Uint8Array(65_536) : PNG;
      sent = true;
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
    answer = failure;
    const { cookie } = await signInWithGitHub({
      id: githubId,
      login: `kept-${n}`,
      name: null,
    });
    expect(await viewerOf(cookie)).toMatchObject({ kind: "member" });
    expect(photoOf(githubId)?.content).toEqual(PNG);
  },
);

test.each(failures)(
  "%s on a first sign-in leaves no photo",
  async (_, n, failure) => {
    const githubId = 7200 + n;
    answer = failure;
    await addMember(`bare-${n}`, [], { githubId });
    expect(photoOf(githubId)).toBeUndefined();
  },
);

test("sign-in asks GitHub for the account's photo by its numeric id, sending no cookie or credential", async () => {
  await addMember("curie", [], { githubId: 7400 });
  expect(calls).toHaveLength(1);
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
  expect(calls).toEqual([]);
  expect(photoOf(7500)).toBeUndefined();
});

test("a GitHub that never answers holds sign-in only until the timeout", async () => {
  // as fetch does, the stub gives up when the signal it was handed aborts
  answer = (init) =>
    new Promise((_, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  const started = Date.now();
  await addMember("patient", [], { githubId: 7600 });
  expect(Date.now() - started).toBeLessThan(4_000);
  expect(photoOf(7600)).toBeUndefined();
}, 10_000);
