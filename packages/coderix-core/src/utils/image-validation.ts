/**
 * Structural validation for inline images sent to the model.
 *
 * The provider rejects the whole request (400 "You have uploaded an
 * unsupported image") when a base64 image block does not decode as the media
 * type it claims — a truncated download that still carries the PNG signature
 * is the usual culprit. Validating before the block reaches the request turns
 * that hard failure into a readable tool error.
 *
 * Only shipped trailers are checked (IEND / EOI / GIF terminator / RIFF size);
 * full decoding is deliberately avoided so this stays dependency-free and cheap
 * enough to run over a session transcript.
 */

export type SupportedImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

const SUPPORTED_MEDIA_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** True when the provider accepts this media type at all. */
export function isSupportedImageMediaType(mediaType: string): mediaType is SupportedImageMediaType {
  return SUPPORTED_MEDIA_TYPES.has(mediaType.toLowerCase());
}

/**
 * Validate decoded image bytes against the declared media type.
 *
 * A trailer that is missing or a RIFF size larger than the payload means the
 * file was cut short (an interrupted download), which the provider cannot
 * decode. Trailing bytes after the trailer are tolerated.
 */
export function isValidImageBuffer(mediaType: string, buf: Buffer): boolean {
  if (buf.length < 8) return false;
  switch (mediaType.toLowerCase()) {
    case 'image/png':
      return (
        buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) &&
        buf.indexOf(PNG_IEND, Math.max(0, buf.length - 16)) !== -1
      );
    case 'image/jpeg': {
      if (!buf.subarray(0, 2).equals(JPEG_SOI)) return false;
      const eoi = buf.lastIndexOf(JPEG_EOI);
      return eoi !== -1 && eoi >= buf.length - 16;
    }
    case 'image/gif':
      return (
        buf.subarray(0, 3).toString('latin1') === 'GIF' &&
        buf[buf.length - 1] === 0x3b
      );
    case 'image/webp': {
      if (buf.length < 16) return false;
      if (buf.subarray(0, 4).toString('latin1') !== 'RIFF') return false;
      if (buf.subarray(8, 12).toString('latin1') !== 'WEBP') return false;
      return buf.readUInt32LE(4) + 8 <= buf.length;
    }
    default:
      return false;
  }
}

/** Convenience wrapper for base64 payloads. */
export function isValidBase64Image(mediaType: string, data: string): boolean {
  if (!data) return false;
  try {
    return isValidImageBuffer(mediaType, Buffer.from(data, 'base64'));
  } catch {
    return false;
  }
}
