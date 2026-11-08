import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryEngine } from '../query-engine.js';
import { SessionManager } from '../session.js';
import { ToolRegistry } from '../tool-registry.js';
import { PermissionMode } from '../types.js';
import type { AssistantMessage, StreamEvent } from '../types.js';
import type { ToolResult } from '../../tools/types.js';

/**
 * Regression: after a stop, the very next message used to vanish.
 *
 * `interrupt()` only aborted the top-level controller. A tool that ignored it
 * kept the turn "active", so the next `submitMessage` queued the message, the
 * desktop bridge dropped the `queued` event, and the user saw every following
 * send fail with "本轮没有收到结束信号".
 */

const TOOL_NAME = 'StuckTool';
const TOOL_USE_ID = 'call_engine_stuck';

/** One tool_use block, streamed the way an adapter emits it. */
async function* modelCallingStuckTool(): AsyncGenerator<StreamEvent | AssistantMessage> {
  yield {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: TOOL_USE_ID, name: TOOL_NAME, input: {} },
  } as StreamEvent;
  yield {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{}' },
  } as StreamEvent;
  yield { type: 'content_block_stop', index: 0 } as StreamEvent;
  yield {
    type: 'message_stop',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: TOOL_USE_ID, name: TOOL_NAME, input: {} }],
      stopReason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  } as unknown as StreamEvent;
}

/** A model that answers with plain text, for the follow-up turn. */
async function* plainAnswer(): AsyncGenerator<StreamEvent | AssistantMessage> {
  yield {
    type: 'message_stop',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  } as unknown as StreamEvent;
}

function stuckExecutor(): Promise<ToolResult> {
  return new Promise(() => { /* never settles */ });
}

describe('QueryEngine — a stop does not swallow the next message', () => {
  let cwd: string;
  let sessionManager: SessionManager;
  let sessionId: string;
  let registry: ToolRegistry;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'coderix-engine-stop-'));
    sessionManager = new SessionManager(true, 'desktop');
    sessionId = sessionManager.create({ title: 't', cwd, model: 'test-model' }).id;

    registry = new ToolRegistry();
    registry.register(
      {
        name: TOOL_NAME,
        description: 'never finishes',
        input_schema: { type: 'object', properties: {} },
        riskLevel: 'safe',
        isConcurrencySafe: true,
        interruptBehavior: 'cancel',
      } as never,
      stuckExecutor as never,
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function makeEngine(callModel: unknown): QueryEngine {
    return new QueryEngine({
      cwd,
      toolRegistry: registry,
      sessionManager,
      model: 'test-model',
      callModel: callModel as never,
      // AUTO so the tool is dispatched instead of waiting on a permission
      // prompt the test never answers.
      settings: { permission_mode: 'auto' },
    } as never);
  }

  it('runs the next turn instead of queueing it, once the stuck turn is stopped', async () => {
    // Both turns share ONE engine instance — that is the state that used to get
    // poisoned (`isActive` stuck true after the interrupt).
    let model: unknown = modelCallingStuckTool;
    const engine = new QueryEngine({
      cwd,
      toolRegistry: registry,
      sessionManager,
      model: 'test-model',
      callModel: ((params: unknown) => (model as (p: unknown) => never)(params)) as never,
      settings: {},
    } as never);
    // AUTO so the tool is dispatched instead of stopping at a permission prompt
    // the test never answers (that path would end the turn without ever
    // reaching the tool-wait loop this regression is about).
    engine.setPermissionMode(PermissionMode.AUTO);

    const firstTurn = (async () => {
      for await (const _ of engine.submitMessage('first')) { /* drain */ }
    })();

    // Wait until the stuck tool is actually dispatched, then stop.
    await new Promise((r) => setTimeout(r, 300));
    engine.interrupt();

    await expect(
      Promise.race([
        firstTurn,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('interrupted turn never unwound')), 8000),
        ),
      ]),
    ).resolves.toBeUndefined();

    // Same engine, next message. With the old behaviour this was queued and
    // then dropped, so the user's input disappeared.
    model = plainAnswer;
    const events: string[] = [];
    const secondTurn = (async () => {
      for await (const event of engine.submitMessage('second')) {
        events.push(event.type);
      }
    })();

    await expect(
      Promise.race([
        secondTurn,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('second turn never ran')), 8000),
        ),
      ]),
    ).resolves.toBeUndefined();

    // The message must have been executed, not parked in the queue.
    expect(events).not.toContain('queued');
    expect(events).toContain('done');
  });
});