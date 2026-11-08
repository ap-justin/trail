import { randomFillSync } from "node:crypto";

/**
 * A UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then random bits, so ids sort
 * as text by creation time to the millisecond. Ids minted in the same
 * millisecond are ordered randomly; cursors order by `created_at`, then `id`.
 */
export function newId(now: number = Date.now()): string {
  const bytes = randomFillSync(new Uint8Array(16));
  // node:crypto ships v4 only (randomUUID), so the v7 layout is written here
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
