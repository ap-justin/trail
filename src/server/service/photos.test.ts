import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import { migrate, openDatabase } from "../db/client.js";
import { actorPhoto } from "../db/schema.js";
import { JPEG, OTHER_PNG, PNG, pngOfSize, WEBP } from "../test-images.js";
import { InvalidImageError } from "./errors.js";
import { createBot } from "./keys.js";
import { setActorPhoto } from "./photos.js";

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
  expect(setActorPhoto(db, actor.id, PNG)).toEqual(first);
  expect(storedAt(actor.id)).toEqual(before);
});

test("setting different bytes moves updatedAt", () => {
  const { actor } = createBot(db, "changed");
  setActorPhoto(db, actor.id, PNG);

  const later = new Date("2026-11-13T00:00:00Z");
  vi.setSystemTime(later);
  setActorPhoto(db, actor.id, OTHER_PNG);
  expect(storedAt(actor.id)).toEqual(later);
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
