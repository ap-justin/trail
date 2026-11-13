// Tiny images by their magic numbers and headers alone: trail reads those bytes, never decodes.

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p)] : p)),
  );

export const PNG = bytes(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0, 0, 0, 0x0d],
);
export const OTHER_PNG = bytes(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [0, 0, 0, 0x0e],
);
export const WEBP = bytes("RIFF", [0x0c, 0, 0, 0], "WEBP", "VP8 ");
export const SVG = bytes(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
export const TEXT = bytes("not an image at all");

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32be = (n: number) => [...u16be(n >>> 16), ...u16be(n & 0xffff)];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32le = (n: number) => [...u24le(n), (n >>> 24) & 0xff];

// Headers alone, a few dozen bytes whatever size they claim: no pixel data follows.

/** A PNG signature and IHDR chunk claiming `width` x `height`. */
export const pngClaiming = (width: number, height: number) =>
  bytes([...PNG], "IHDR", u32be(width), u32be(height), [8, 6, 0, 0, 0]);

/**
 * A JPEG whose JFIF and Exif segments and a quantization table come before the
 * frame header (`sof`, baseline C0 by default) claiming `width` x `height`.
 */
export const jpegClaiming = (
  width: number,
  height: number,
  { sof = 0xc0 }: { sof?: number } = {},
) =>
  bytes(
    [0xff, 0xd8],
    [0xff, 0xe0, ...u16be(16)],
    "JFIF",
    [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xe1, ...u16be(8)],
    "Exif",
    [0, 0],
    [0xff, 0xdb, ...u16be(4), 0, 1],
    [0xff, sof, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3],
    [1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  );

/** The header of a 48 x 48 baseline JPEG, frame header included: a JPEG declaring no size is refused. */
export const JPEG = jpegClaiming(48, 48);

/** A WebP whose VP8 (lossy), VP8L (lossless) or VP8X (extended) header claims `width` x `height`. */
export const webpClaiming = (
  kind: "VP8" | "VP8L" | "VP8X",
  width: number,
  height: number,
) => {
  const chunk =
    kind === "VP8"
      ? bytes(
          "VP8 ",
          u32le(10),
          [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a],
          [
            width & 0xff,
            (width >> 8) & 0x3f,
            height & 0xff,
            (height >> 8) & 0x3f,
          ],
        )
      : kind === "VP8L"
        ? bytes(
            "VP8L",
            u32le(5),
            [0x2f],
            u32le(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)),
          )
        : bytes(
            "VP8X",
            u32le(10),
            [0, 0, 0, 0],
            u24le(width - 1),
            u24le(height - 1),
          );
  return bytes("RIFF", u32le(4 + chunk.length), "WEBP", [...chunk]);
};

/** A PNG of exactly `size` bytes. */
export const pngOfSize = (size: number) => {
  const out = new Uint8Array(size);
  out.set(PNG);
  return out;
};
