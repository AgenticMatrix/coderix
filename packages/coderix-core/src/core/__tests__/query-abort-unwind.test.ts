import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query } from '../query.js';
import { SessionManager } from '../session.js';
import { ToolRegistry } from '../tool-registry.js';
import { PermissionEngine } from '../permission.js';
import { CheckpointManager } from '../checkpoint.js';
import { normalizeMessagesForAPI } from '../message-normalizer.js';
import type { Message, QueryMessage, AssistantMessage, StreamEvent } from '../types.js';
import { PermissionMode } from '../types.js';
import type { ToolResult } from '../../tools/types.js';
import type { SystemPrompt } from '../system-prompt.js';

/**
 * Regression: a tool that ignores the abort signal used to hang the turn.
 *
 * `query()` waits in a polling loop for every queued tool to settle. With no
 * abort check inside that loop, a stuck tool held the generator open forever —
 * the engine's `finally` never ran, `isActive` stayed true, and every later
 * message in the session was silently queued and then failed with
 * "no end signal".
 */

const TOOL_NAME = 'StuckTool';
const TOOL_USE_ID = 'call_stuck';

/**
 * Streams exactly one tool_use block, then a `message_stop` claiming
 * `tool_use` — the same shape a real adapter produces. `orderedBlocks` is only
 * populated from `content_block_stop`, so the deltas are required.
 */
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

/** A tool that never honours its signal — the pathological case. */
function stuckExecutor(): Promise<ToolResult> {
  return new Promise(() => { /* never settles */ });
}

const SYSTEM_PROMPT: SystemPrompt = {
  prompt: 'you are a test agent',
  parts: [{ name: 'test', content: 'you are a test agent', priority: 0 }],
};

const USER_MESSAGE: Message = { role: 'user', content: 'do the thing' };

describe('query() — abort unwinds a stuck tool', () => {
  let cwd: string;
  let sessionManager: SessionManager;
  let sessionId: string;
  let registry: ToolRegistry;
  let abortController: AbortController;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'coderix-abort-'));
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

    abortController = new AbortController();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('finishes the generator once the signal is aborted, answering every tool_use', async () => {
    const collected: QueryMessage[] = [];
    // The `assistant` event is only emitted after the tool-wait loop, so the
    // tool's own "running" progress event is what proves it was dispatched.
    let toolStarted = false;

    // AUTO so the tool runs without waiting on a permission answer the test
    // never gives (the default ASK mode would block before the tool starts).
    const permissionEngine = new PermissionEngine(cwd);
    permissionEngine.setMode(PermissionMode.AUTO);

    const consumer = (async () => {
      for await (const event of query({
        sessionId,
        cwd,
        messages: [USER_MESSAGE],
        systemPrompt: SYSTEM_PROMPT,
        toolRegistry: registry,
        permissionEngine,
        sessionManager,
        checkpointManager: new CheckpointManager(),
        abortController,
        maxTurns: 5,
        contextBudget: 100_000,
        compactThreshold: 0.85,
        autoCompactEnabled: false,
        callModel: modelCallingStuckTool as never,
      })) {
        if (
          event.type === 'system' &&
          (event as { subtype?: string }).subtype === 'progress' &&
          (event as { data?: { toolUseId?: string; status?: string } }).data?.toolUseId === TOOL_USE_ID &&
          (event as { data?: { status?: string } }).data?.status === 'running'
        ) {
          toolStarted = true;
        }
        collected.push(event);
      }
    })();

    const deadline = Date.now() + 3000;
    while (!toolStarted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(toolStarted).toBe(true);
    // Let the tool-wait loop reach a poll tick, then interrupt.
    await new Promise((r) => setTimeout(r, 50));
    abortController.abort();

    await expect(
      Promise.race([
        consumer,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('query() never unwound after abort')), 5000),
        ),
      ]),
    ).resolves.toBeUndefined();

    // The turn must still produce a matching tool_result for the stuck tool,
    // otherwise the next request is rejected for an unanswered tool call.
    const assistant = collected.find((e) => e.type === 'assistant') as
      | { message: AssistantMessage }
      | undefined;
    expect(assistant).toBeDefined();

    const userMessages = collected.filter(
      (e) => e.type === 'user',
    ) as Array<{ message: Message }>;
    const allResults = userMessages.flatMap((e) =>
      (e.message.content as unknown as Array<Record<string, unknown>>)
        .filter((b) => b.type === 'tool_result'),
    );

    expect(allResults.length).toBeGreaterThan(0);
    expect(allResults[0]!.tool_use_id).toBe(TOOL_USE_ID);
    expect(allResults[0]!.is_error).toBe(true);

    const normalized = normalizeMessagesForAPI([assistant!.message, userMessages[0]!.message]);
    const ids = new Set(
      (normalized[1]!.content as unknown as Array<Record<string, unknown>>)
        .filter((b) => b.type === 'tool_result')
        .map((b) => b.tool_use_id),
    );
    expect(ids.has(TOOL_USE_ID)).toBe(true);
  });
});