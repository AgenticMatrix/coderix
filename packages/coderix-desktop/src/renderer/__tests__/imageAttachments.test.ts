import { describe, it, expect } from 'vitest';
import {
  MAX_EDGE,
  base64ByteLength,
  isSupportedImageType,
  normalizeFiles,
  planResize,
  stripDataUrlPrefix,
  type ImageAttachment,
} from '../lib/imageAttachments.js';

/**
 * The canvas path needs a browser (`createImageBitmap` / `OffscreenCanvas`), so
 * these tests cover the pure helpers and the admission rules that run before
 * any decoding. The vitest environment is `node`, so no DOM is available.
 */

describe('isSupportedImageType', () => {
  it('accepts the four provider media types', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(isSupportedImageType(type)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isSupportedImageType('IMAGE/PNG')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const type of ['image/svg+xml', 'application/pdf', 'text/plain', '']) {
      expect(isSupportedImageType(type)).toBe(false);
    }
  });
});

describe('stripDataUrlPrefix', () => {
  it('returns the payload after the comma', () => {
    expect(stripDataUrlPrefix('data:image/png;base64,AAAA')).toBe('AAAA');
  });

  it('returns the input when there is no prefix', () => {
    expect(stripDataUrlPrefix('AAAA')).toBe('AAAA');
  });

  it('keeps the last segment when the payload contains commas', () => {
    // Base64 never contains a comma, but a malformed URL should not truncate
    // the payload at the wrong place.
    expect(stripDataUrlPrefix('data:image/png;base64,AA,BB')).toBe('AA,BB');
  });
});

describe('planResize', () => {
  it('leaves an image inside the limit alone', () => {
    expect(planResize(800, 600)).toBeNull();
    expect(planResize(MAX_EDGE, MAX_EDGE)).toBeNull();
  });

  it('scales the long edge down to MAX_EDGE, preserving aspect ratio', () => {
    const target = planResize(3136, 1568)!;
    expect(target.width).toBe(MAX_EDGE);
    expect(target.height).toBe(784);
  });

  it('handles a portrait image by capping the height', () => {
    const target = planResize(1000, 4000)!;
    expect(target.height).toBe(MAX_EDGE);
    expect(target.width).toBe(392);
  });

  it('never rounds a dimension down to zero', () => {
    const target = planResize(100000, 1)!;
    expect(target.height).toBe(1);
    expect(target.width).toBe(MAX_EDGE);
  });

  it('does not divide by zero on an empty image', () => {
    expect(planResize(0, 0)).toBeNull();
  });
});

describe('base64ByteLength', () => {
  it('counts padding correctly', () => {
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength('QQ==')).toBe(1); // 'A'
    expect(base64ByteLength('QUI=')).toBe(2); // 'AB'
    expect(base64ByteLength('QUJD')).toBe(3); // 'ABC'
  });
});

describe('normalizeFiles — admission rules', () => {
  const existing: ImageAttachment[] = [];

  /** A File stand-in: normalizeFiles only reads `type` and `size` up front. */
  function fileOf(type: string, size = 1024, name = 'x'): File {
    return { type, size, name } as unknown as File;
  }

  it('ignores non-image files without reporting an error', async () => {
    const result = await normalizeFiles([fileOf('application/pdf')], existing);
    expect(result.accepted).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects an image over the size ceiling with the too-large code', async () => {
    const result = await normalizeFiles([fileOf('image/png', 9 * 1024 * 1024)], existing);
    expect(result.accepted).toHaveLength(0);
    expect(result.errors[0]!.code).toBe('too-large');
  });

  it('reports too-many once the per-message cap is reached', async () => {
    // Pretend eight images are already attached, so there is no room left.
    const full: ImageAttachment[] = Array.from({ length: 8 }, (_, i) => ({
      id: `img-${i}`,
      mediaType: 'image/png' as const,
      data: 'AA==',
      previewUrl: 'data:image/png;base64,AA==',
      width: 1,
      height: 1,
      bytes: 1,
    }));

    const result = await normalizeFiles([fileOf('image/png')], full);
    expect(result.accepted).toHaveLength(0);
    expect(result.errors[0]!.code).toBe('too-many');
  });
});