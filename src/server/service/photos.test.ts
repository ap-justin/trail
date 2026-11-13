import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { actorPhoto } from "../db/schema.js";
import {
  JPEG,
  jpegClaiming,
  OTHER_PNG,
  PNG,
  pngClaiming,
  pngOfSize,
  WEBP,
  webpClaiming,
} from "../test-images.js";
import { InvalidImageError, PayloadTooLargeError } from "./errors.js";
import { createBot } from "./keys.js";
import {
  clearActorPhoto,
  readActorPhoto,
  setActorPhoto,
  touchActorPhoto,
} from "./photos.js";

const dir = mkdtempSync(join(tmpdir(), "trail-photos-"));
const db = openDatabase(join(dir, "trail.db"));
migrate(db);
afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const storedAt = (actorId: string) =>
  db
    .select({ updatedAt: actorPhoto.updatedAt })
    .from(actorPhoto)
    .where(eq(actorPhoto.actorId, actorId))
    .get()?.updatedAt;

test("setting the same bytes again leaves the photo's updatedAt as it was", () => {
  const { actor } = createBot(db, "same");
  const first = setActorPhoto(db, actor.id, PNG);
  const before = storedAt(actor.id);

  vi.setSystemTime(new Date("2026-11-13T00:00:00Z"));
  expect(setActorPhoto(db, actor.id, PNG)).toEqual({
    photoUrl: first.photoUrl,
    changed: false,
  });
  expect(storedAt(actor.id)).toEqual(before);
});

test("a first photo and different bytes report a change", () => {
  const { actor } = createBot(db, "reports");
  expect(setActorPhoto(db, actor.id, PNG).changed).toBe(true);
  expect(setActorPhoto(db, actor.id, OTHER_PNG).changed).toBe(true);
});

test("clearing reports whether there was a photo to remove", () => {
  const { actor } = createBot(db, "cleared");
  expect(clearActorPhoto(db, actor.id)).toBe(false);
  setActorPhoto(db, actor.id, PNG);
  expect(clearActorPhoto(db, actor.id)).toBe(true);
  expect(clearActorPhoto(db, actor.id)).toBe(false);
});

test("touching a photo moves only its updatedAt; an actor without one is left as it is", () => {
  const { actor } = createBot(db, "touched");
  const { photoUrl } = setActorPhoto(db, actor.id, PNG);
  const later = new Date("2026-11-13T00:00:00Z");
  vi.setSystemTime(later);
  touchActorPhoto(db, actor.id);
  expect(storedAt(actor.id)).toEqual(later);
  const hash = photoUrl.split("/").at(-1) ?? "";
  expect(readActorPhoto(db, actor.id, hash)?.content).toEqual(Buffer.from(PNG));

  const { actor: bare } = createBot(db, "bare");
  touchActorPhoto(db, bare.id);
  expect(storedAt(bare.id)).toBeUndefined();
});

test("setting different bytes moves updatedAt", () => {
  const { actor } = createBot(db, "changed");
  setActorPhoto(db, actor.id, PNG);

  const later = new Date("2026-11-13T00:00:00Z");
  vi.setSystemTime(later);
  setActorPhoto(db, actor.id, OTHER_PNG);
  expect(storedAt(actor.id)).toEqual(later);
});

test("a replacing photo stores its own bytes and type under its own hash", () => {
  const { actor } = createBot(db, "replaced");
  const first = setActorPhoto(db, actor.id, PNG);
  const { photoUrl } = setActorPhoto(db, actor.id, JPEG);
  const hash = photoUrl.split("/").at(-1) ?? "";

  expect(readActorPhoto(db, actor.id, hash)).toEqual({
    content: Buffer.from(JPEG),
    contentType: "image/jpeg",
  });
  expect(
    readActorPhoto(db, actor.id, first.photoUrl.split("/").at(-1) ?? ""),
  ).toBeNull();
});

test("setting A, then B, then A again gives A back its original URL and bytes", () => {
  const { actor } = createBot(db, "round-trip");
  const first = setActorPhoto(db, actor.id, PNG).photoUrl;
  const hashOf = (url: string) => url.split("/").at(-1) ?? "";
  setActorPhoto(db, actor.id, JPEG);
  expect(readActorPhoto(db, actor.id, hashOf(first))).toBeNull();

  expect(setActorPhoto(db, actor.id, PNG).photoUrl).toBe(first);
  expect(readActorPhoto(db, actor.id, hashOf(first))).toEqual({
    content: Buffer.from(PNG),
    contentType: "image/png",
  });
  expect(
    db.select().from(actorPhoto).where(eq(actorPhoto.actorId, actor.id)).all(),
  ).toHaveLength(1);
});

// the literal 262144 is the schema's CHECK bound; a service limit drifting from it surfaces here
test("a photo of exactly 262144 bytes is stored whole, and one byte more is refused", () => {
  const { actor } = createBot(db, "biggest");
  setActorPhoto(db, actor.id, pngOfSize(262144));
  const stored = db
    .select({ content: actorPhoto.content })
    .from(actorPhoto)
    .where(eq(actorPhoto.actorId, actor.id))
    .get();
  expect(stored?.content.length).toBe(262144);

  expect(() => setActorPhoto(db, actor.id, pngOfSize(262145))).toThrow(
    /262145 bytes/,
  );
});

const riff = (form: string) =>
  new Uint8Array([...Buffer.from(`RIFF\x0c\0\0\0${form}data`, "latin1")]);

test.each([
  ["a RIFF container that is not WebP (WAVE)", riff("WAVE")],
  ["a RIFF container that is not WebP (AVI)", riff("AVI ")],
  ["RIFF with no form type", new Uint8Array(Buffer.from("RIFF"))],
  ["a PNG signature cut short", PNG.slice(0, 7)],
  ["a JPEG signature cut short", JPEG.slice(0, 2)],
])("%s is refused as not an image", (_, bytes) => {
  const { actor } = createBot(db, `sniff-${bytes.length}-${bytes[8]}`);
  expect(() => setActorPhoto(db, actor.id, bytes)).toThrow(InvalidImageError);
  expect(storedAt(actor.id)).toBeUndefined();
});

test("a WebP is typed by its form type, not just its RIFF header", () => {
  const { actor } = createBot(db, "webp-ok");
  setActorPhoto(db, actor.id, WEBP);
  const stored = db
    .select({ contentType: actorPhoto.contentType })
    .from(actorPhoto)
    .where(eq(actorPhoto.actorId, actor.id))
    .get();
  expect(stored?.contentType).toBe("image/webp");
});

let pixelBots = 0;
const pixelBot = () => createBot(db, `pixels-${++pixelBots}`).actor;

/** The refusal of a photo claiming `width` x `height`, its message checked for the numbers and the way out. */
const refusesPixels = (bytes: Uint8Array, width: number, height: number) => {
  const actor = pixelBot();
  let thrown: unknown;
  try {
    setActorPhoto(db, actor.id, bytes);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(InvalidImageError);
  expect((thrown as Error).message).toBe(
    `the photo is ${width} x ${height} pixels (${bytes.length} bytes, within the 256 KB limit, but each side must be at most 1024): resize it to 1024 x 1024 or smaller and send it again`,
  );
  expect(storedAt(actor.id)).toBeUndefined();
};

const claims = {
  PNG: pngClaiming,
  JPEG: jpegClaiming,
  "progressive JPEG": (w: number, h: number) =>
    jpegClaiming(w, h, { sof: 0xc2 }),
  "lossy WebP": (w: number, h: number) => webpClaiming("VP8", w, h),
  "lossless WebP": (w: number, h: number) => webpClaiming("VP8L", w, h),
  "extended WebP": (w: number, h: number) => webpClaiming("VP8X", w, h),
};
const largest = {
  PNG: 65535,
  JPEG: 65535,
  "progressive JPEG": 65535,
  "lossy WebP": 16383,
  "lossless WebP": 16383,
  "extended WebP": 65535,
};

describe.each(Object.keys(claims) as (keyof typeof claims)[])(
  "a %s's pixel size, read from its header",
  (format) => {
    const claiming = claims[format];
    test("1024 x 1024 is stored", () => {
      const actor = pixelBot();
      expect(setActorPhoto(db, actor.id, claiming(1024, 1024)).changed).toBe(
        true,
      );
    });
    test("1025 wide is refused", () => {
      refusesPixels(claiming(1025, 1024), 1025, 1024);
    });
    test("1025 tall is refused", () => {
      refusesPixels(claiming(1024, 1025), 1024, 1025);
    });
    test("the largest a header can claim is refused, numbers named", () => {
      const side = largest[format];
      refusesPixels(claiming(side, side), side, side);
    });
  },
);

const malformedLength = (length: number) => {
  const jpeg = jpegClaiming(4000, 3000);
  jpeg.set([length >> 8, length & 0xff], 4); // the JFIF segment's length
  return jpeg;
};

test.each([
  ["a PNG cut inside its IHDR", pngClaiming(4000, 3000).slice(0, 20)],
  [
    "a PNG whose first chunk is not IHDR",
    (() => {
      const png = pngClaiming(4000, 3000);
      png.set([...Buffer.from("tEXt")], 12);
      return png;
    })(),
  ],
  [
    "a lossy WebP cut inside its frame header",
    webpClaiming("VP8", 4000, 3000).slice(0, 29),
  ],
  [
    "a lossy WebP without its start code",
    (() => {
      const webp = webpClaiming("VP8", 4000, 3000);
      webp[23] = 0;
      return webp;
    })(),
  ],
  [
    "a lossless WebP cut inside its header",
    webpClaiming("VP8L", 4000, 3000).slice(0, 24),
  ],
  [
    "a lossless WebP without its signature",
    (() => {
      const webp = webpClaiming("VP8L", 4000, 3000);
      webp[20] = 0;
      return webp;
    })(),
  ],
  [
    "an extended WebP cut inside its canvas size",
    webpClaiming("VP8X", 4000, 3000).slice(0, 29),
  ],
])("%s declares no size and is stored as before", (_, bytes) => {
  const actor = pixelBot();
  expect(setActorPhoto(db, actor.id, bytes).changed).toBe(true);
});

const strayByte = (() => {
  const jpeg = jpegClaiming(8000, 8000);
  // 20 is where the Exif segment's marker starts, just past the JFIF segment
  return new Uint8Array([...jpeg.slice(0, 20), 0x00, ...jpeg.slice(20)]);
})();

// a browser skips a stray byte between segments and draws the image at the size it finds after it
test.each([
  ["a JPEG with a stray byte between its segments", strayByte],
  ["a JPEG cut inside its frame header", jpegClaiming(4000, 3000).slice(0, 44)],
  ["a JPEG with a segment length under 2", malformedLength(1)],
  ["a JPEG with a segment length past its end", malformedLength(0xffff)],
  ["a JPEG that ends before its frame header", JPEG.slice(0, 36)],
])("%s declares no size and is refused", (_, bytes) => {
  const actor = pixelBot();
  expect(() => setActorPhoto(db, actor.id, bytes)).toThrow(
    new InvalidImageError(
      `the photo is a JPEG whose header does not declare its pixel size (${bytes.length} bytes): re-save it as a JPEG of at most 1024 x 1024 pixels and send it again`,
    ),
  );
  expect(storedAt(actor.id)).toBeUndefined();
});

test("a JPEG's fill bytes and marker-only segments are walked past to its frame header", () => {
  const jpeg = jpegClaiming(4000, 3000);
  // SOI, two fill bytes, a restart marker, then the rest of the segments
  const walked = new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xff,
    0xff,
    0xd0,
    ...jpeg.slice(2),
  ]);
  refusesPixels(walked, 4000, 3000);
});

test("a body over 256 KB is refused by its byte size before its header is read", () => {
  const actor = pixelBot();
  const big = pngOfSize(262145);
  big.set(pngClaiming(4000, 3000));
  expect(() => setActorPhoto(db, actor.id, big)).toThrow(PayloadTooLargeError);
  expect(() => setActorPhoto(db, actor.id, big)).toThrow(
    /262145 bytes, over the limit/,
  );
});
