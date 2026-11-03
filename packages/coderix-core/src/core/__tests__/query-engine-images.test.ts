import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryEngine } from '../query-engine.js';
import { SessionManager } from '../session.js';
import { ToolRegistry } from '../tool-registry.js';
import type { ContentBlock } from '../types.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A callModel that never streams anything: `submitMessage` records the user
 * turn before the agent loop starts, so the assertion does not need a real
 * model response.
 */
async function* emptyModel(): AsyncGenerator<never> {
  return;
}

function makeEngine(cwd: string) {
  const sessionManager = new SessionManager(true, 'desktop');
  const session = sessionManager.create({ title: 'test', cwd, model: 'test-model' });
  const engine = new QueryEngine({
    cwd,
    toolRegistry: new ToolRegistry(),
    sessionManager,
    model: 'test-model',
    callModel: emptyModel as never,
    settings: {},
  });
  return { engine, sessionManager, sessionId: session.id };
}

/** The first user message the engine wrote for this turn. */
function firstUserMessage(sessionManager: SessionManager, sessionId: string): ContentBlock[] {
  const session = sessionManager.get(sessionId)!;
  const message = session.messages.find((m) => m.role === 'user')!;
  return message.content as ContentBlock[];
}

describe('QueryEngine.submitMessage — image input', () => {
  it('prepends image blocks to the user message, text last', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'coderix-img-'));
    try {
      const { engine, sessionManager, sessionId } = makeEngine(cwd);

      // Drain the generator; the turn ends immediately on the empty stream.
      for await (const _ of engine.submitMessage('这图里有什么？', [
        { mediaType: 'image/png', data: PNG_1X1 },
      ])) { /* drain */ }

      const blocks = firstUserMessage(sessionManager, sessionId);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toMatchObject({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PNG_1X1 },
      });
      expect(blocks[1]).toEqual({ type: 'text', text: '这图里有什么？' });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('keeps multiple images in order', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'coderix-img-'));
    try {
      const { engine, sessionManager, sessionId } = makeEngine(cwd);
      const second = Buffer.from('second-image').toString('base64');

      for await (const _ of engine.submitMessage('对比这两张', [
        { mediaType: 'image/png', data: PNG_1X1 },
        { mediaType: 'image/jpeg', data: second },
      ])) { /* drain */ }

      const blocks = firstUserMessage(sessionManager, sessionId);
      expect(blocks.filter((b) => b.type === 'image')).toHaveLength(2);
      expect(blocks[0]!.source!.media_type).toBe('image/png');
      expect(blocks[1]!.source!.media_type).toBe('image/jpeg');
      expect(blocks[2]).toEqual({ type: 'text', text: '对比这两张' });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('accepts an image-only turn with no text block', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'coderix-img-'));
    try {
      const { engine, sessionManager, sessionId } = makeEngine(cwd);

      for await (const _ of engine.submitMessage('', [
        { mediaType: 'image/png', data: PNG_1X1 },
      ])) { /* drain */ }

      const blocks = firstUserMessage(sessionManager, sessionId);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.type).toBe('image');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('leaves a text-only turn as a plain string (no regression)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'coderix-img-'));
    try {
      const { engine, sessionManager, sessionId } = makeEngine(cwd);

      for await (const _ of engine.submitMessage('你好')) { /* drain */ }

      const session = sessionManager.get(sessionId)!;
      const message = session.messages.find((m) => m.role === 'user')!;
      expect(message.content).toBe('你好');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('MessageQueue — images survive deferral', () => {
  it('passes queued images through to the drain callback', async () => {
    const { MessageQueue } = await import('../message-queue.js');
    const queue = new MessageQueue();
    const drained = vi.fn();
    queue.onDrain(drained);

    queue.enqueue('later', [{ mediaType: 'image/png', data: PNG_1X1 }]);
    queue.drainNext();

    expect(drained).toHaveBeenCalledWith('later', [
      { mediaType: 'image/png', data: PNG_1X1 },
    ]);
  });
});