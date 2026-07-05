/**
 * Unit tests for gatewayToWebview — the core translation layer
 * that maps GatewayEvent → WebviewOutboundMessage[].
 */
import { describe, it, expect } from 'vitest';
import { gatewayToWebview } from '../../packages/coderix-vscode/src/bridge/gatewayToWebview';
import type { GatewayEvent } from '../../packages/coderix-vscode/src/bridge/events';

const sid = 'test-session-1';

// ── Streaming messages ──────────────────────────────────────

describe('gatewayToWebview — streaming', () => {
  it('message.delta → messageDelta', () => {
    const ev: GatewayEvent = {
      type: 'message.delta',
      payload: { text: 'Hello world' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'messageDelta', text: 'Hello world', sessionId: sid });
  });

  it('message.start → empty array', () => {
    const ev: GatewayEvent = { type: 'message.start', payload: {}, session_id: sid };
    expect(gatewayToWebview(ev, '')).toEqual([]);
  });

  it('message.complete → messageComplete with usage info', () => {
    const ev: GatewayEvent = {
      type: 'message.complete',
      payload: {
        text: 'Final response',
        usage: { calls: 3, input: 500, output: 200, cache: 100, total: 700 },
      },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'messageComplete',
      text: 'Final response',
      usage: { calls: 3, input: 500, output: 200, cache: 100, total: 700 },
      sessionId: sid,
    });
  });
});

// ── Thinking / reasoning ────────────────────────────────────

describe('gatewayToWebview — thinking', () => {
  it('thinking.delta → thinkingDelta', () => {
    const ev: GatewayEvent = {
      type: 'thinking.delta',
      payload: { text: 'Let me think about this...' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'thinkingDelta', text: 'Let me think about this...' });
  });

  it('reasoning.delta → thinkingDelta', () => {
    const ev: GatewayEvent = {
      type: 'reasoning.delta',
      payload: { text: 'Analyzing the problem...' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'thinkingDelta', text: 'Analyzing the problem...' });
  });

  it('reasoning.available → thinkingDelta', () => {
    const ev: GatewayEvent = {
      type: 'reasoning.available',
      payload: { text: 'Reasoning available' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'thinkingDelta', text: 'Reasoning available' });
  });
});

// ── Tool execution ──────────────────────────────────────────

describe('gatewayToWebview — tools', () => {
  it('tool.start → toolStart', () => {
    const ev: GatewayEvent = {
      type: 'tool.start',
      payload: { tool_id: 'tool_001', name: 'Bash', args_text: '{"command":"ls"}' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'toolStart', toolId: 'tool_001', name: 'Bash', args: '{"command":"ls"}' });
  });

  it('tool.complete → toolComplete with resultText', () => {
    const ev: GatewayEvent = {
      type: 'tool.complete',
      payload: {
        tool_id: 'tool_001',
        name: 'Read',
        duration_s: 2.5,
        result_text: 'file contents here',
      },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'toolComplete',
      toolId: 'tool_001',
      name: 'Read',
      durationMs: 2500,
      resultText: 'file contents here',
    });
  });

  it('tool.complete with error', () => {
    const ev: GatewayEvent = {
      type: 'tool.complete',
      payload: { tool_id: 'tool_002', name: 'Bash', duration_s: 1.0, error: 'Command failed' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({ type: 'toolComplete', error: 'Command failed' });
  });
});

// ── Status updates ──────────────────────────────────────────

describe('gatewayToWebview — status', () => {
  it('status.update with thinking kind → thinking status', () => {
    const ev: GatewayEvent = {
      type: 'status.update',
      payload: { text: 'Thinking...', kind: 'thinking' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({ type: 'statusUpdate', status: 'thinking' });
  });

  it('status.update with generating kind → generating status', () => {
    const ev: GatewayEvent = {
      type: 'status.update',
      payload: { text: 'Generating...', kind: 'generating' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({ type: 'statusUpdate', status: 'generating' });
  });

  it('status.update with tool kind → running_tool status', () => {
    const ev: GatewayEvent = {
      type: 'status.update',
      payload: { text: 'Running Bash...', kind: 'tool' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({ type: 'statusUpdate', status: 'running_tool' });
  });

  it('status.update with error kind → error status', () => {
    const ev: GatewayEvent = {
      type: 'status.update',
      payload: { text: 'Something broke', kind: 'error' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({ type: 'statusUpdate', status: 'error' });
  });
});

// ── Sub-agent events ────────────────────────────────────────

describe('gatewayToWebview — subagent', () => {
  it('subagent.spawn_requested → subagentProgress running', () => {
    const ev: GatewayEvent = {
      type: 'subagent.spawn_requested',
      payload: { subagent_id: 'ag-001', goal: 'Search for files', task_index: 0, task_count: 5 },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'subagentProgress',
      agentId: 'ag-001',
      goal: 'Search for files',
      status: 'running',
      taskIndex: 0,
      taskCount: 5,
    });
  });

  it('subagent.progress → subagentProgress with tool info', () => {
    const ev: GatewayEvent = {
      type: 'subagent.progress',
      payload: {
        subagent_id: 'ag-001',
        goal: 'Read code',
        task_index: 2,
        task_count: 5,
        tool_name: 'Grep',
        files_read: ['src/a.ts'],
        files_written: [],
      },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({
      type: 'subagentProgress',
      status: 'running',
      currentTool: 'Grep',
      filesRead: ['src/a.ts'],
    });
  });

  it('subagent.complete → subagentProgress completed with summary', () => {
    const ev: GatewayEvent = {
      type: 'subagent.complete',
      payload: {
        subagent_id: 'ag-001',
        goal: 'Found 3 files',
        status: 'completed',
        task_index: 5,
        task_count: 5,
        duration_seconds: 12.5,
        input_tokens: 500,
        output_tokens: 200,
        files_read: ['src/a.ts', 'src/b.ts'],
        files_written: ['src/c.ts'],
        summary: 'Modified 1 file, read 2 files',
      },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({
      type: 'subagentProgress',
      agentId: 'ag-001',
      goal: 'Found 3 files',
      status: 'completed',
      taskIndex: 5,
      taskCount: 5,
      durationSeconds: 12.5,
      tokensUsed: 700,
      filesRead: ['src/a.ts', 'src/b.ts'],
      filesWritten: ['src/c.ts'],
      summary: 'Modified 1 file, read 2 files',
    });
  });

  it('subagent.complete with interrupted status', () => {
    const ev: GatewayEvent = {
      type: 'subagent.complete',
      payload: { subagent_id: 'ag-002', goal: 'Killed task', status: 'interrupted', task_index: 1, task_count: 3 },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({ type: 'subagentProgress', status: 'interrupted' });
  });

  it('subagent.complete with failed status → error', () => {
    const ev: GatewayEvent = {
      type: 'subagent.complete',
      payload: { subagent_id: 'ag-003', goal: 'Failed task', status: 'failed', task_index: 1, task_count: 3 },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({ type: 'subagentProgress', status: 'error' });
  });
});

// ── Background task ─────────────────────────────────────────

describe('gatewayToWebview — background', () => {
  it('background.complete → subagentProgress', () => {
    const ev: GatewayEvent = {
      type: 'background.complete',
      payload: { task_id: 'bg-001', text: 'Background scan done' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'subagentProgress',
      agentId: 'bg-001',
      goal: 'Background task',
      status: 'completed',
      summary: 'Background scan done',
    });
  });
});

// ── Approval + error ────────────────────────────────────────

describe('gatewayToWebview — approval + error', () => {
  it('approval.request → approvalRequest', () => {
    const ev: GatewayEvent = {
      type: 'approval.request',
      payload: { request_id: 'req-1', command: 'rm -rf /', description: 'Destructive command' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'approvalRequest',
      requestId: 'req-1',
      command: 'rm -rf /',
      description: 'Destructive command',
    });
  });

  it('error → errorMessage + statusUpdate', () => {
    const ev: GatewayEvent = {
      type: 'error',
      payload: { message: 'Something went wrong' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ type: 'errorMessage', message: 'Something went wrong' });
    expect(result[1]).toMatchObject({ type: 'statusUpdate', status: 'error' });
  });
});

// ── Session management ──────────────────────────────────────

describe('gatewayToWebview — session', () => {
  it('session.info → configUpdate', () => {
    const ev: GatewayEvent = {
      type: 'session.info',
      payload: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'configUpdate',
      config: { model: 'claude-sonnet-4-6', provider: '', permissionMode: 'ask' },
    });
  });

  it('sessionSwitched → correct message', () => {
    const ev: GatewayEvent = {
      type: 'sessionSwitched',
      sessionId: 'sess-1',
      title: 'My session',
      session_id: sid,
    };
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({ type: 'sessionSwitched', sessionId: 'sess-1', title: 'My session' });
  });

  it('sessionHistory → correct message', () => {
    const ev: GatewayEvent = {
      type: 'sessionHistory',
      messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }],
      sessionId: 'sess-1',
      session_id: sid,
    } as any;
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({
      type: 'sessionHistory',
      messages: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }],
      sessionId: 'sess-1',
    });
  });
});

// ── Still-dropped events (no regression) ────────────────────

describe('gatewayToWebview — still dropped', () => {
  const droppedTypes = [
    'gateway.ready', 'gateway.stderr', 'gateway.start_timeout',
    'gateway.protocol_error', 'skin.changed',
    'voice.status', 'voice.transcript', 'browser.progress',
    'clarify.request', 'sudo.request', 'secret.request',
    'review.summary', 'subagent.thinking', 'subagent.tool',
  ] as const;

  for (const type of droppedTypes) {
    it(`${type} → empty array`, () => {
      const ev: GatewayEvent = { type, payload: {}, session_id: sid } as any;
      expect(gatewayToWebview(ev, '')).toEqual([]);
    });
  }
});

// ── Session ID fallback ─────────────────────────────────────

describe('gatewayToWebview — session ID', () => {
  it('uses event session_id over parameter', () => {
    const ev: GatewayEvent = {
      type: 'message.delta',
      payload: { text: 'hi' },
      session_id: 'from-event',
    };
    const result = gatewayToWebview(ev, 'from-param');
    expect(result[0]).toMatchObject({ sessionId: 'from-event' });
  });

  it('falls back to parameter sessionId when event has none', () => {
    const ev: GatewayEvent = {
      type: 'message.delta',
      payload: { text: 'hi' },
    } as any;
    const result = gatewayToWebview(ev, 'fallback-id');
    expect(result[0]).toMatchObject({ sessionId: 'fallback-id' });
  });
});

// ── Missing payload tolerance ───────────────────────────────

describe('gatewayToWebview — missing payload', () => {
  it('message.delta without text → empty string', () => {
    const ev: GatewayEvent = { type: 'message.delta', payload: {}, session_id: sid } as any;
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({ type: 'messageDelta', text: '' });
  });

  it('thinking.delta without text → empty string', () => {
    const ev: GatewayEvent = { type: 'thinking.delta', payload: {}, session_id: sid } as any;
    const result = gatewayToWebview(ev, '');
    expect(result[0]).toMatchObject({ type: 'thinkingDelta', text: '' });
  });

  it('tool.start without args_text → undefined', () => {
    const ev: GatewayEvent = {
      type: 'tool.start',
      payload: { tool_id: 't1', name: 'Read' },
      session_id: sid,
    } as any;
    const result = gatewayToWebview(ev, '');
    expect(result[0].args).toBeUndefined();
  });
});
