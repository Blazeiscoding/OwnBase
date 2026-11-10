/**
 * Reads pixel dimensions straight out of image headers — no native decoder.
 * Clients use these to reserve space before the image loads, so timelines
 * don't jump. Returns null for anything unrecognized.
 */
export type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** The type an image's first bytes say it is, or null for anything else. */
export function imageTypeOf(bytes: Uint8Array): ImageType | null {
  const at = (offset: number, ...expected: number[]) =>
    bytes.length >= offset + expected.length && expected.every((b, i) => bytes[offset + i] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  // "RIFF", four bytes of length, "WEBP".
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  return null;
}

export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  const type = imageTypeOf(buf);

  // PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
  if (type === "image/png") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a", then little-endian uint16 width/height.
  if (type === "image/gif") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP: VP8/VP8L/VP8X each store size differently.
  if (type === "image/webp") {
    const format = buf.toString("ascii", 12, 16);
    if (format === "VP8 " && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (format === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (format === "VP8X" && buf.length >= 30) {
      const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16));
      const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16));
      return { width, height };
    }
    return null;
  }

  // JPEG: walk the marker segments to the SOFn frame header.
  if (type === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1]!;
      // SOFn frames carry the dimensions; SOF4/8/12 are not frame headers.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + buf.readUInt16BE(offset + 2);
    }
  }

  return null;
}
