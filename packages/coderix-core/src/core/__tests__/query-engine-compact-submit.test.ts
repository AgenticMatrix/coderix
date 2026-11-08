import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryEngine } from '../query-engine.js';
import { SessionManager } from '../session.js';
import { ToolRegistry } from '../tool-registry.js';
import { PermissionMode } from '../types.js';
import type { AssistantMessage, StreamEvent } from '../types.js';

/**
 * Regression: a message sent during compaction must be parked immediately.
 *
 * `/compact` first interrupts the running turn, which leaves the engine's
 * `abortController` aborted. The submit guard has a branch for exactly that
 * state ("wait for the aborted turn to unwind, up to 3s"). During compaction
 * that branch is wrong: compaction has a live consumer that drains the queue
 * when it finishes, so the message just sits for the full grace window first.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('QueryEngine — submit during compaction', () => {
  let cwd: string;
  let sessionManager: SessionManager;
  let sessionId: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'coderix-compact-'));
    sessionManager = new SessionManager(true, 'desktop');
    sessionId = sessionManager.create({ title: 't', cwd, model: 'test-model' }).id;
    for (let i = 0; i < 6; i++) {
      sessionManager.addMessage({ role: 'user', content: `seed ${i}` });
    }
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('queues the message without waiting out the abort grace window', async () => {
    let slow = true;

    const engine = new QueryEngine({
      cwd,
      toolRegistry: new ToolRegistry(),
      sessionManager,
      model: 'test-model',
      callModel: (() =>
        (async function* (): AsyncGenerator<StreamEvent | AssistantMessage> {
          // The summarization call is slow — that keeps compaction running
          // while the message is submitted. Normal answers are instant.
          if (slow) await sleep(3000);
          yield {
            type: 'message_stop',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: slow ? 'SUMMARY' : 'ok' }],
              stopReason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 2 },
            },
          } as unknown as StreamEvent;
        })()) as never,
      settings: {},
    } as never);
    engine.setPermissionMode(PermissionMode.AUTO);

    // Put the engine in the exact state /compact creates: a real turn that was
    // then interrupted, so `abortController.signal.aborted` is true.
    const abortedTurn = (async () => {
      for await (const _ of engine.submitMessage('before compact')) { /* drain */ }
    })();
    await sleep(200);
    engine.interrupt();
    await Promise.race([abortedTurn, sleep(3000)]);

    const compaction = (async () => {
      for await (const _ of engine.compact()) { /* drain */ }
    })();
    await sleep(100);

    const started = Date.now();
    const events: string[] = [];
    let answeredAt = -1;
    const submit = (async () => {
      for await (const event of engine.submitMessage('during compaction')) {
        if (answeredAt < 0) answeredAt = Date.now() - started;
        events.push(event.type);
        if (event.type === 'done') break;
      }
    })();
    await sleep(400);

    // Must answer within the first poll; without the guard this is the 3s wait.
    expect(answeredAt).toBeGreaterThanOrEqual(0);
    expect(answeredAt).toBeLessThan(1000);
    expect(events).toContain('queued');

    slow = false;
    engine.interrupt();
    await Promise.race([Promise.allSettled([compaction, submit]), sleep(8000)]);
  }, 20000);
});