// Tiny images by their magic numbers alone: trail sniffs the leading bytes, never decodes.

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
export const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10], "JFIF");
export const WEBP = bytes("RIFF", [0x0c, 0, 0, 0], "WEBP", "VP8 ");
export const SVG = bytes(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
export const TEXT = bytes("not an image at all");

/** A PNG of exactly `size` bytes. */
export const pngOfSize = (size: number) => {
  const out = new Uint8Array(size);
  out.set(PNG);
  return out;
};
