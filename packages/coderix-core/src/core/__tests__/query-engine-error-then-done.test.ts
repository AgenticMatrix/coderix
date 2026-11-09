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
 * Repro for the "cad-harness conversation ended on its own" report.
 *
 * After a successful tool step the engine calls the model again. When that call
 * fails (the endpoint goes dark and the 120s idle timeout fires on every retry),
 * `query()` yields a system `error` message and returns. The engine loop then
 * ends *normally*, so it emits its terminal `done` right after the error. The
 * desktop bridge forwards both: the error first, then a turn-done carrying the
 * previous step's `tool_use` stop reason — which the renderer renders as a
 * clean "完成". The failure is erased.
 */

const TOOL = 'EchoTool';

function toolUseStep(): StreamEvent[] {
  return [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: TOOL, input: {} },
    } as StreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    } as StreamEvent,
    { type: 'content_block_stop', index: 0 } as StreamEvent,
    {
      type: 'message_stop',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: TOOL, input: {} }],
        stopReason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    } as unknown as StreamEvent,
  ];
}

describe('QueryEngine — a failed model call after a tool step', () => {
  let cwd: string;
  let sessionManager: SessionManager;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'coderix-error-done-'));
    sessionManager = new SessionManager(true, 'desktop');
    sessionManager.create({ title: 't', cwd, model: 'test-model' });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function makeRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register(
      {
        name: TOOL,
        description: 'echo',
        input_schema: { type: 'object', properties: {} },
        riskLevel: 'safe',
        isConcurrencySafe: true,
        interruptBehavior: 'cancel',
      } as never,
      (async () => ({ content: 'ok', isError: false })) as never,
    );
    return registry;
  }

  it('does not follow its terminal error with a `done` event', async () => {
    const registry = makeRegistry();
    // First step hands off to a tool; every later call fails the way a dead
    // endpoint does once the idle timeout fires.
    let calls = 0;
    const engine = new QueryEngine({
      cwd,
      toolRegistry: registry,
      sessionManager,
      model: 'test-model',
      callModel: (async function* () {
        calls += 1;
        if (calls === 1) {
          for (const ev of toolUseStep()) yield ev;
          return;
        }
        throw new Error('Model request timed out after 120000ms with no data');
      }) as never,
      settings: {},
    } as never);
    engine.setPermissionMode(PermissionMode.AUTO);

    const seen: string[] = [];
    for await (const event of engine.submitMessage('go')) {
      seen.push(event.type === 'error' ? 'error' : event.type);
    }

    // The error is the turn's ending. A `done` after it claims the turn
    // completed, and the desktop renderer believes `done` over the error.
    expect(seen).toContain('error');
    expect(seen.slice(seen.indexOf('error'))).not.toContain('done');
  }, 30000);

  it('still emits `done` when an error was recoverable and the turn went on', async () => {
    const registry = makeRegistry();
    // A compaction failure is reported as an error but the turn then continues
    // and produces its real answer. The later messages must clear the failure
    // state, otherwise a recoverable error would suppress the turn's ending.
    let calls = 0;
    const engine = new QueryEngine({
      cwd,
      toolRegistry: registry,
      sessionManager,
      model: 'test-model',
      callModel: (async function* () {
        calls += 1;
        if (calls === 1) {
          for (const ev of toolUseStep()) yield ev;
          return;
        }
        yield {
          type: 'message_stop',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'finished' }],
            stopReason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        } as unknown as StreamEvent;
      }) as never,
      settings: {},
    } as never);
    engine.setPermissionMode(PermissionMode.AUTO);

    const seen: string[] = [];
    for await (const event of engine.submitMessage('go')) {
      seen.push(event.type);
    }

    expect(seen).not.toContain('error');
    expect(seen).toContain('done');
  }, 30000);
});