import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from '../executor.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let dir: string;

function run(filePath: string) {
  return execute({ file_path: filePath }, {
    cwd: dir,
    allowMutation: false,
    maxOutput: 10_000,
    bashTimeout: 1_000,
  } as any);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coderix-read-image-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Read tool — image handling', () => {
  it('returns a valid PNG as an image block', async () => {
    writeFileSync(join(dir, 'ok.png'), Buffer.from(PNG_1X1, 'base64'));
    const result = await run('ok.png');
    expect(result.isError).toBe(false);
    expect(result.image?.media_type).toBe('image/png');
    expect(Buffer.from(result.image!.data, 'base64').subarray(0, 8).toString('hex')).toBe(
      '89504e470d0a1a0a',
    );
  });

  it('reports a truncated PNG instead of sending an undecodable image', async () => {
    const truncated = Buffer.from(PNG_1X1, 'base64').subarray(0, 40);
    writeFileSync(join(dir, 'truncated.png'), truncated);
    const result = await run('truncated.png');
    expect(result.isError).toBe(true);
    expect(result.image).toBeUndefined();
    expect(result.content).toContain('not a valid image/png');
  });

  it('names unsupported formats instead of mislabelling them as PNG', async () => {
    writeFileSync(join(dir, 'picture.bmp'), Buffer.from('BM\x00\x00\x00\x00', 'latin1'));
    const result = await run('picture.bmp');
    expect(result.isError).toBe(true);
    expect(result.image).toBeUndefined();
    expect(result.content).toContain('not supported');
  });

  it('still reads SVG source as text', async () => {
    writeFileSync(join(dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const result = await run('icon.svg');
    expect(result.isError).toBe(false);
    expect(result.content).toContain('<svg');
  });
});
