import { createHash } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type ActorPhotoContentType, actorPhoto } from "../db/schema.js";
import { InvalidImageError, PayloadTooLargeError } from "./errors.js";
import type { Tx } from "./tx.js";

/** The most bytes a photo may have; the actor_photo content check holds the same bound. */
export const PHOTO_MAX_BYTES = 256 * 1024;

/** What a photo may be, for a refusal to name. */
export const PHOTO_ACCEPTS = `a PNG, JPEG or WebP image of at most ${PHOTO_MAX_BYTES} bytes (256 KB)`;

export const photoTooLarge = (size: number | null) =>
  `the photo is ${size === null ? "" : `${size} bytes, `}over the limit: send ${PHOTO_ACCEPTS}, resized or recompressed to fit`;

const ascii = (text: string) => [...Buffer.from(text, "ascii")];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");

/** The image type the leading bytes declare, or null for anything but PNG, JPEG and WebP. */
function sniffImageType(bytes: Uint8Array): ActorPhotoContentType | null {
  const startsWith = (signature: number[], at = 0) =>
    signature.every((b, i) => bytes[at + i] === b);
  if (startsWith(PNG)) return "image/png";
  if (startsWith(JPEG)) return "image/jpeg";
  if (startsWith(RIFF) && startsWith(WEBP, 8)) return "image/webp";
  return null;
}

/** The path a photo is served at; it changes with the bytes, so a client may cache it forever. */
export function photoUrl(actorId: string, hash: string): string;
export function photoUrl(actorId: string, hash: string | null): string | null;
export function photoUrl(actorId: string, hash: string | null) {
  return hash === null ? null : `/api/photos/${actorId}/${hash}`;
}

/**
 * Stores `bytes` as the actor's photo, replacing any it had, typed by its
 * leading bytes; bytes equal to the stored photo's leave its row untouched.
 * Throws `PayloadTooLargeError` over `PHOTO_MAX_BYTES` and `InvalidImageError`
 * for an empty body or anything but PNG, JPEG and WebP.
 */
export function setActorPhoto(
  db: Db | Tx,
  actorId: string,
  bytes: Uint8Array,
): { photoUrl: string } {
  if (bytes.length > PHOTO_MAX_BYTES) {
    throw new PayloadTooLargeError(photoTooLarge(bytes.length));
  }
  if (bytes.length === 0) {
    throw new InvalidImageError(`the photo is empty: send ${PHOTO_ACCEPTS}`);
  }
  const contentType = sniffImageType(bytes);
  if (contentType === null) {
    throw new InvalidImageError(
      `the photo's bytes are not a PNG, JPEG or WebP image (SVG, GIF and other formats are not stored): convert it and send ${PHOTO_ACCEPTS}`,
    );
  }
  const content = Buffer.from(bytes);
  const hash = createHash("sha256").update(content).digest("hex");
  const set = { content, contentType, hash, updatedAt: new Date() };
  db.insert(actorPhoto)
    .values({ actorId, ...set })
    .onConflictDoUpdate({
      target: actorPhoto.actorId,
      set,
      // the same bytes again (a GitHub avatar on every sign-in) write nothing
      setWhere: ne(actorPhoto.hash, hash),
    })
    .run();
  return { photoUrl: photoUrl(actorId, hash) };
}

/** Removes the actor's photo; an actor without one is left as it is. */
export function clearActorPhoto(db: Db | Tx, actorId: string): void {
  db.delete(actorPhoto).where(eq(actorPhoto.actorId, actorId)).run();
}

/** The actor's photo URL, or null without one; reads the hash, never the bytes. */
export function photoUrlOf(db: Db | Tx, actorId: string): string | null {
  const row = db
    .select({ hash: actorPhoto.hash })
    .from(actorPhoto)
    .where(eq(actorPhoto.actorId, actorId))
    .get();
  return photoUrl(actorId, row?.hash ?? null);
}

/** The stored photo when `hash` is its current hash, else null. */
export function readActorPhoto(
  db: Db,
  actorId: string,
  hash: string,
): { content: Buffer; contentType: ActorPhotoContentType } | null {
  const row = db
    .select({
      content: actorPhoto.content,
      contentType: actorPhoto.contentType,
    })
    .from(actorPhoto)
    .where(and(eq(actorPhoto.actorId, actorId), eq(actorPhoto.hash, hash)))
    .get();
  return row ?? null;
}
