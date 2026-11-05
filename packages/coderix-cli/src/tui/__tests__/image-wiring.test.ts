import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the two wiring points that once dropped attachments before they
 * reached the engine.
 *
 * The image was staged correctly (reducer tested), and `submitMessage` accepted
 * it (engine tested), yet nothing arrived at the model — because `App.handleSend`
 * called `runAgentTurn(text)` without the images, and the queue-drain listener
 * declared only `(message)`. Neither layer had a test, so both regressions were
 * invisible. These assertions read the real sources and fail if either call
 * site stops forwarding.
 *
 * A behavioural test would be better than a source assertion, but mounting the
 * full App needs a live session, MCP servers and a real terminal; the reducer
 * and handler behaviour is covered in input-handler-images.test.tsx.
 */

const src = (rel: string) =>
  readFileSync(join(process.cwd(), 'packages/coderix-cli/src/tui', rel), 'utf8');

describe('App.handleSend forwards images', () => {
  const app = src('components/App.tsx');

  it('declares the images parameter', () => {
    expect(app).toMatch(/const handleSend = useCallback\(async \(text: string, images\?: PendingImage\[\]\)/);
  });

  it('passes images into runAgentTurn instead of dropping them', () => {
    // The old broken form was exactly `await runAgentTurn(text);`.
    expect(app).toContain('runAgentTurn(text, images?.length ? { images } : undefined)');
  });
});

describe('queue drain forwards images', () => {
  const bridge = src('hooks/useAgentBridge.ts');

  it('declares both drain parameters', () => {
    expect(bridge).toContain('engine.onQueueDrain((message, images) =>');
  });

  it('hands images to runAgentTurn for the deferred turn', () => {
    expect(bridge).toContain('runAgentTurnRef.current(message, { fromQueue: true, images })');
  });
});

describe('submit path allows image-only turns', () => {
  const handler = src('hooks/useInputHandler.ts');
  const bridge = src('hooks/useAgentBridge.ts');

  it('the input handler sends when there are images but no text', () => {
    expect(handler).toContain('cur.trim().length > 0 || hasImages');
    expect(handler).toContain('onSend(expandedText, hasImages ? pendingImages : undefined)');
  });

  it('the bridge does not bail out on empty text when images exist', () => {
    expect(bridge).toMatch(/if \(trimmed\.length === 0 && !images\?\.length\) return;/);
  });

  it('the engine receives the images as the second argument', () => {
    expect(bridge).toContain('engine.submitMessage(trimmed, images)');
  });
});