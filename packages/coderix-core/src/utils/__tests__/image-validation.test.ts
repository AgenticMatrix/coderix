import { describe, it, expect } from 'vitest';
import {
  isSupportedImageMediaType,
  isValidBase64Image,
  isValidImageBuffer,
} from '../image-validation.js';

/** 1x1 transparent PNG (valid, ends with the IEND chunk). */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function pngBuffer(): Buffer {
  return Buffer.from(PNG_1X1, 'base64');
}

describe('image-validation', () => {
  it('recognises the media types the provider accepts', () => {
    expect(isSupportedImageMediaType('image/png')).toBe(true);
    expect(isSupportedImageMediaType('image/JPEG')).toBe(true);
    expect(isSupportedImageMediaType('image/gif')).toBe(true);
    expect(isSupportedImageMediaType('image/webp')).toBe(true);
    expect(isSupportedImageMediaType('image/bmp')).toBe(false);
    expect(isSupportedImageMediaType('image/svg+xml')).toBe(false);
  });

  it('rejects an empty payload', () => {
    expect(isValidImageBuffer('image/png', Buffer.alloc(0))).toBe(false);
    expect(isValidBase64Image('image/png', '')).toBe(false);
  });

  it('accepts a complete PNG and rejects a truncated one', () => {
    const png = pngBuffer();
    expect(isValidImageBuffer('image/png', png)).toBe(true);
    expect(isValidBase64Image('image/png', PNG_1X1)).toBe(true);

    // An interrupted download keeps the signature but loses the IEND chunk.
    const truncated = png.subarray(0, png.length - 12);
    expect(isValidImageBuffer('image/png', truncated)).toBe(false);
    expect(isValidBase64Image('image/png', truncated.toString('base64'))).toBe(false);
  });

  it('checks that the bytes match the declared media type', () => {
    expect(isValidImageBuffer('image/jpeg', pngBuffer())).toBe(false);
    expect(isValidImageBuffer('image/bmp', pngBuffer())).toBe(false);
  });

  it('accepts a complete JPEG and rejects one without EOI', () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9,
    ]);
    expect(isValidImageBuffer('image/jpeg', jpeg)).toBe(true);
    expect(isValidImageBuffer('image/jpeg', jpeg.subarray(0, jpeg.length - 2))).toBe(false);
  });

  it('requires the GIF trailer byte', () => {
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1');
    expect(isValidImageBuffer('image/gif', gif)).toBe(true);
    expect(isValidImageBuffer('image/gif', gif.subarray(0, gif.length - 1))).toBe(false);
  });

  it('rejects a WebP whose RIFF size exceeds the payload', () => {
    const webp = Buffer.alloc(20);
    webp.write('RIFF', 0, 'latin1');
    webp.writeUInt32LE(12, 4); // file size = total - 8
    webp.write('WEBP', 8, 'latin1');
    expect(isValidImageBuffer('image/webp', webp)).toBe(true);

    const truncated = Buffer.from(webp);
    truncated.writeUInt32LE(400, 4);
    expect(isValidImageBuffer('image/webp', truncated)).toBe(false);
  });
});
