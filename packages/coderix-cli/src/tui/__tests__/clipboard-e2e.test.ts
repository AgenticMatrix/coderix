import { describe, it, expect } from 'vitest';
import { readClipboardImage, describeImage } from '../clipboard-image.js';
import { QueryEngine, SessionManager, ToolRegistry } from '@coderix/core';

/**
 * Exercises the real clipboard read on this machine and pushes the result
 * through the engine, proving the payload shape matches what submitMessage
 * expects. Skipped when the clipboard holds no image (CI, headless sessions).
 */
describe('clipboard → engine', () => {
  it('turns a clipboard image into image-then-text content blocks', async () => {
    const clip = await readClipboardImage();
    if (!clip.ok) {
      // No image on the clipboard — nothing to assert against.
      expect(['no-image', 'unsupported-platform', 'read-failed']).toContain(clip.error.code);
      return;
    }

    const sm = new SessionManager(true, 'cli');
    const session = sm.create({ title: 'clip', cwd: process.cwd(), model: 'm' });
    const engine = new QueryEngine({
      cwd: process.cwd(),
      toolRegistry: new ToolRegistry(),
      sessionManager: sm,
      model: 'm',
      callModel: (async function* () { return; }) as never,
      settings: {},
    });

    for await (const _ of engine.submitMessage('这是什么', [clip.image])) { /* drain */ }

    const message = sm.get(session.id)!.messages.find((m) => m.role === 'user')!;
    const blocks = message.content as Array<any>;
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].source.media_type).toBe(clip.image.mediaType);
    expect(blocks[0].source.data).toBe(clip.image.data);
    expect(blocks[1]).toMatchObject({ type: 'text', text: '这是什么' });
    expect(describeImage(clip.image)).toMatch(/\d+×\d+ (PNG|JPEG|GIF|WEBP) \d+KB/);
  });
});
