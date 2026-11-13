import { createHash } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type ActorPhotoContentType, actorPhoto } from "../db/schema.js";
import { InvalidImageError, PayloadTooLargeError } from "./errors.js";
import type { Tx } from "./tx.js";

/** The most bytes a photo may have; the actor_photo content check holds the same bound. */
export const PHOTO_MAX_BYTES = 256 * 1024;

/** The most pixels a photo may have on either side, as its header declares them. */
export const PHOTO_MAX_SIDE = 1024;

/** What a photo may be, for a refusal to name. */
export const PHOTO_ACCEPTS = `a PNG, JPEG or WebP image of at most ${PHOTO_MAX_BYTES} bytes (256 KB) and ${PHOTO_MAX_SIDE} x ${PHOTO_MAX_SIDE} pixels`;

export const photoTooLarge = (size: number | null) =>
  `the photo is ${size === null ? "" : `${size} bytes, `}over the limit: send ${PHOTO_ACCEPTS}, resized or recompressed to fit`;

export const photoTooManyPixels = (
  { width, height }: Dimensions,
  size: number,
) =>
  `the photo is ${width} x ${height} pixels (${size} bytes, within the 256 KB limit, but each side must be at most ${PHOTO_MAX_SIDE}): resize it to ${PHOTO_MAX_SIDE} x ${PHOTO_MAX_SIDE} or smaller and send it again`;

const ascii = (text: string) => [...Buffer.from(text, "ascii")];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");
const IHDR = ascii("IHDR");

const startsWithAt = (bytes: Uint8Array, signature: number[], at: number) =>
  signature.every((b, i) => bytes[at + i] === b);

/** The image type the leading bytes declare, or null for anything but PNG, JPEG and WebP. */
export function sniffImageType(
  bytes: Uint8Array,
): ActorPhotoContentType | null {
  const startsWith = (signature: number[], at = 0) =>
    startsWithAt(bytes, signature, at);
  if (startsWith(PNG)) return "image/png";
  if (startsWith(JPEG)) return "image/jpeg";
  if (startsWith(RIFF) && startsWith(WEBP, 8)) return "image/webp";
  return null;
}

type Dimensions = { width: number; height: number };

/** The frame-header markers that carry a JPEG's size: C0–CF but DHT (C4), JPG (C8) and DAC (CC). */
const isJpegFrameHeader = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

function jpegDimensions(view: DataView): Dimensions | null {
  let at = 2;
  while (at + 4 <= view.byteLength) {
    if (view.getUint8(at) !== 0xff) return null;
    const marker = view.getUint8(at + 1);
    if (marker === 0xff) {
      at += 1; // fill byte before a marker
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2; // a marker without a length
      continue;
    }
    // end of image, or scan data with no frame header before it
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = view.getUint16(at + 2);
    if (length < 2) return null;
    if (isJpegFrameHeader(marker)) {
      if (length < 7 || at + 9 > view.byteLength) return null;
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

function webpDimensions(view: DataView): Dimensions | null {
  if (view.byteLength < 16) return null;
  const chunk = String.fromCharCode(
    ...[12, 13, 14, 15].map((i) => view.getUint8(i)),
  );
  if (
    chunk === "VP8 " &&
    view.byteLength >= 30 &&
    view.getUint8(23) === 0x9d &&
    view.getUint8(24) === 0x01 &&
    view.getUint8(25) === 0x2a
  ) {
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && view.byteLength >= 25 && view.getUint8(20) === 0x2f) {
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && view.byteLength >= 30) {
    const u24 = (at: number) =>
      view.getUint16(at, true) | (view.getUint8(at + 2) << 16);
    return { width: u24(24) + 1, height: u24(27) + 1 };
  }
  return null;
}

/**
 * The pixel size the image's header declares, from a few fixed bytes or, for a
 * JPEG, a walk over its segment lengths; nothing is decoded. Null when the header
 * is too short or malformed to say.
 */
function declaredDimensions(
  bytes: Uint8Array,
  type: ActorPhotoContentType,
): Dimensions | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/jpeg") return jpegDimensions(view);
  if (type === "image/webp") return webpDimensions(view);
  if (bytes.length < 24 || !startsWithAt(bytes, IHDR, 12)) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** The path a photo is served at; it changes with the bytes, so a client may cache it forever. */
export function photoUrl(actorId: string, hash: string): string;
export function photoUrl(actorId: string, hash: string | null): string | null;
export function photoUrl(actorId: string, hash: string | null) {
  return hash === null ? null : `/api/photos/${actorId}/${hash}`;
}

/**
 * Stores `bytes` as the actor's photo, replacing any it had, typed by its
 * leading bytes; bytes equal to the stored photo's leave its row untouched,
 * and `changed` says whether the row was written. Throws `PayloadTooLargeError`
 * over `PHOTO_MAX_BYTES` and `InvalidImageError` for an empty body, anything but
 * PNG, JPEG and WebP, a header declaring a side over `PHOTO_MAX_SIDE` pixels,
 * or a JPEG whose header declares no size (a PNG or WebP header too short or
 * malformed to declare a size passes).
 */
export function setActorPhoto(
  db: Db | Tx,
  actorId: string,
  bytes: Uint8Array,
): { photoUrl: string; changed: boolean } {
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
  const declared = declaredDimensions(bytes, contentType);
  // a browser skips stray bytes between segments to a frame header this walk never reaches
  if (declared === null && contentType === "image/jpeg") {
    throw new InvalidImageError(
      `the photo is a JPEG whose header does not declare its pixel size (${bytes.length} bytes): re-save it as a JPEG of at most ${PHOTO_MAX_SIDE} x ${PHOTO_MAX_SIDE} pixels and send it again`,
    );
  }
  if (
    declared !== null &&
    (declared.width > PHOTO_MAX_SIDE || declared.height > PHOTO_MAX_SIDE)
  ) {
    throw new InvalidImageError(photoTooManyPixels(declared, bytes.length));
  }
  const content = Buffer.from(bytes);
  const hash = createHash("sha256").update(content).digest("hex");
  const { changes } = db
    .insert(actorPhoto)
    .values({ actorId, content, contentType, hash, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: actorPhoto.actorId,
      // excluded.* reuses the inserted row's values, so the blob is bound once
      set: {
        content: sql`excluded.content`,
        contentType: sql`excluded.content_type`,
        hash: sql`excluded.hash`,
        updatedAt: sql`excluded.updated_at`,
      },
      // the same bytes again (a GitHub avatar on every sign-in) write nothing
      setWhere: ne(actorPhoto.hash, hash),
    })
    .run();
  return { photoUrl: photoUrl(actorId, hash), changed: changes > 0 };
}

/** Removes the actor's photo, true when it had one; an actor without one is left as it is. */
export function clearActorPhoto(db: Db | Tx, actorId: string): boolean {
  return (
    db.delete(actorPhoto).where(eq(actorPhoto.actorId, actorId)).run().changes >
    0
  );
}

/** Marks the actor's photo as current without rewriting it; an actor without one is left as it is. */
export function touchActorPhoto(db: Db | Tx, actorId: string): void {
  db.update(actorPhoto)
    .set({ updatedAt: new Date() })
    .where(eq(actorPhoto.actorId, actorId))
    .run();
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
