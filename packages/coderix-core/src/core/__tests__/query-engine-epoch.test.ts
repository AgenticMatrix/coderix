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
 * Regression: a reclaimed turn must not wipe the live turn's tool count.
 *
 * Each `query()` call owns its own ToolExecutionQueue, but that queue reports
 * its running count into the *shared* engine. When a turn is force-reclaimed
 * because its tool ignored the abort, the stale queue settles later and reports
 * 0 — which used to erase the live turn's count. The live turn then looked idle,
 * so the next message aborted its blocking tool and ran concurrently in a
 * single-session engine instead of waiting.
 *
 * The fix is an epoch: only the turn that owns the engine may write the count.
 */

const STUCK_TOOL = 'StuckTool';
const BLOCK_TOOL = 'BlockTool';
const STUCK_ID = 'call_stuck';
const BLOCK_ID = 'call_block';

/**
 * How long the stale tool waits before settling on its own. It must outlive
 * `ABORT_UNWIND_GRACE_MS` (3s) so the reclaim happens first, but kept as tight
 * as possible: this test holds real timers, and a long one starves the other
 * files' fire-and-forget disk flushes when the suite runs in parallel.
 */
const STALE_SETTLE_MS = 3400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* toolUseModel(name: string, id: string): AsyncGenerator<StreamEvent | AssistantMessage> {
  yield {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id, name, input: {} },
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
      content: [{ type: 'tool_use', id, name, input: {} }],
      stopReason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  } as unknown as StreamEvent;
}

describe('QueryEngine — a reclaimed turn cannot wipe the live turn\u2019s tool count', () => {
  let cwd: string;
  let sessionManager: SessionManager;
  let sessionId: string;
  let releaseBlock: () => void;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'coderix-epoch-'));
    sessionManager = new SessionManager(true, 'desktop');
    sessionId = sessionManager.create({ title: 't', cwd, model: 'test-model' }).id;
    releaseBlock = () => {};
  });

  afterEach(() => {
    releaseBlock();
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * `StuckTool` ignores its signal and settles late — that late settle is what
   * reports 0 into the shared counter. `BlockTool` holds the turn open.
   */
  function makeRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    const tools: Array<[string, () => Promise<ToolResult>]> = [
      [
        STUCK_TOOL,
        () =>
          new Promise<ToolResult>((resolve) => {
            setTimeout(() => resolve({ content: 'late', isError: false }), STALE_SETTLE_MS);
          }),
      ],
      [
        BLOCK_TOOL,
        () =>
          new Promise<ToolResult>((resolve) => {
            releaseBlock = () => resolve({ content: 'released', isError: false });
          }),
      ],
    ];
    for (const [name, exec] of tools) {
      registry.register(
        {
          name,
          description: `${name} test tool`,
          input_schema: { type: 'object', properties: {} },
          riskLevel: 'safe',
          isConcurrencySafe: false,
          // 'block' is what makes a still-running tool a reason to queue the
          // next message rather than abort it.
          interruptBehavior: 'block',
        } as never,
        exec as never,
      );
    }
    return registry;
  }

  it('keeps the live turn\u2019s blocking tool visible to the next submit', async () => {
    const registry = makeRegistry();
    // One engine for all turns: this is the shared state that used to be
    // clobbered by the reclaimed turn's stale queue.
    let model: unknown = () => toolUseModel(STUCK_TOOL, STUCK_ID);
    const engine = new QueryEngine({
      cwd,
      toolRegistry: registry,
      sessionManager,
      model: 'test-model',
      callModel: ((p: unknown) => (model as (x: unknown) => never)(p)) as never,
      settings: {},
    } as never);
    engine.setPermissionMode(PermissionMode.AUTO);

    // Turn A: stuck tool, then stop. It cannot unwind, so the next submit
    // force-reclaims the engine after the grace window.
    const turnA = (async () => {
      for await (const _ of engine.submitMessage('A')) { /* drain */ }
    })();
    await sleep(300);
    engine.interrupt();

    // Turn B: dispatched right away. Its blocking tool stays running.
    model = () => toolUseModel(BLOCK_TOOL, BLOCK_ID);
    const turnB = (async () => {
      for await (const _ of engine.submitMessage('B')) { /* drain */ }
    })();

    // Wait past both the reclaim grace window AND the stale tool's settle time,
    // so A's queue reports 0 while B still holds a blocking tool.
    await sleep(STALE_SETTLE_MS + 400);

    // Turn C must be QUEUED, not run: B still holds a blocking tool. Without the
    // epoch guard, A's stale queue had zeroed the shared count, so C aborted B's
    // tool and ran concurrently.
    const eventsC: string[] = [];
    const turnC = (async () => {
      for await (const event of engine.submitMessage('C')) {
        eventsC.push(event.type);
      }
    })();
    await sleep(300);

    expect(eventsC).toContain('queued');
    expect(eventsC).not.toContain('done');

    releaseBlock();
    engine.interrupt();
    await Promise.race([Promise.allSettled([turnA, turnB, turnC]), sleep(5000)]);
  }, 30000);
});