import { describe, it, expect } from 'vitest';
import { describeImage, dimensionsOf, planResize, MAX_EDGE } from '../clipboard-image.js';

/**
 * The clipboard read itself shells out to the OS, so these tests cover the pure
 * parts: header parsing, size planning and the transcript label. The live path
 * was smoke-tested manually against a real pasteboard.
 */

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gifHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10);
  buf.write('GIF89a', 0, 'latin1');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function jpegHeader(width: number, height: number): Buffer {
  // SOI, then an APP0 segment to prove the walker skips non-SOF markers,
  // then SOF0 with the real dimensions.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpVP8XHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8X', 12, 'latin1');
  // 24-bit little-endian canvas size, minus one.
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

describe('dimensionsOf', () => {
  it('reads PNG values from the IHDR header', () => {
    expect(dimensionsOf(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('reads GIF logical screen size little-endian', () => {
    expect(dimensionsOf(gifHeader(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('walks JPEG segments to the SOF marker', () => {
    expect(dimensionsOf(jpegHeader(800, 600))).toEqual({ width: 800, height: 600 });
  });

  it('reads the WebP VP8X canvas size', () => {
    expect(dimensionsOf(webpVP8XHeader(1024, 768))).toEqual({ width: 1024, height: 768 });
  });

  it('returns null for bytes it cannot identify', () => {
    expect(dimensionsOf(Buffer.from('not an image at all'))).toBeNull();
    expect(dimensionsOf(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for a truncated PNG header', () => {
    expect(dimensionsOf(pngHeader(10, 10).subarray(0, 12))).toBeNull();
  });
});

describe('planResize', () => {
  it('leaves an image inside the limit untouched', () => {
    expect(planResize(800, 600)).toBeNull();
    expect(planResize(MAX_EDGE, MAX_EDGE)).toBeNull();
  });

  it('caps the long edge and keeps the aspect ratio', () => {
    const t = planResize(3840, 2160)!;
    expect(t.width).toBe(MAX_EDGE);
    expect(t.height).toBe(882);
  });

  it('caps a portrait image by height', () => {
    const t = planResize(1000, 4000)!;
    expect(t.height).toBe(MAX_EDGE);
    expect(t.width).toBe(392);
  });

  it('never rounds a side down to zero', () => {
    const t = planResize(100000, 1)!;
    expect(t.height).toBe(1);
    expect(t.width).toBe(MAX_EDGE);
  });

  it('returns null for a zero-sized image', () => {
    expect(planResize(0, 0)).toBeNull();
  });
});

describe('describeImage', () => {
  it('formats size, format and bytes', () => {
    expect(
      describeImage({ mediaType: 'image/png', width: 1920, height: 1080, bytes: 2048 }),
    ).toBe('1920×1080 PNG 2KB');
  });

  it('never reports zero KB', () => {
    expect(
      describeImage({ mediaType: 'image/jpeg', width: 10, height: 10, bytes: 12 }),
    ).toBe('10×10 JPEG 1KB');
  });

  it('handles webp', () => {
    expect(
      describeImage({ mediaType: 'image/webp', width: 100, height: 50, bytes: 1536 }),
    ).toBe('100×50 WEBP 2KB');
  });
});