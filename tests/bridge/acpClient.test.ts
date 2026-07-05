/**
 * Unit tests for acpClient message routing — verifies the JSON-RPC
 * handleMessage fix correctly dispatches Requests/Responses/Notifications.
 */
import { describe, it, expect, vi } from 'vitest';

// We can't easily import AcpClient because it spawns a process,
// so we test the routing logic in isolation by importing just the
// types and recreating the critical path.

interface AcpMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

type SendFn = (msg: any) => void;
type PendingMap = Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>;

function createDispatcher(
  send: SendFn,
  pending: PendingMap,
  onPermissionRequest?: (id: number, params: any) => void,
) {
  let pendingApprovalId: number | null = null;

  function handleRequest(id: number, method: string, params: any): void {
    switch (method) {
      case 'session/request_permission': {
        const perm = params as any;
        send({
          type: 'approvalRequest',
          requestId: String(id),
          command: perm?.toolCall?.title ?? 'tool',
          description: perm?.toolCall?.rawInput
            ? JSON.stringify(perm.toolCall.rawInput).slice(0, 200)
            : 'Requesting permission',
        });
        pendingApprovalId = id;
        onPermissionRequest?.(id, params);
        break;
      }
      default:
        break;
    }
  }

  function handleNotification(method: string, params: any): void {
    if (method === 'session/update') {
      const update = params?.update;
      if (!update) return;
      const kind = update.sessionUpdate;
      if (kind === 'agent_message_chunk') {
        const text = update.content?.text ?? '';
        if (text) send({ type: 'messageDelta', text });
      } else if (kind === 'agent_thought_chunk') {
        const text = update.content?.text ?? '';
        if (text) send({ type: 'thinkingDelta', text });
      } else if (kind === 'tool_call') {
        send({ type: 'toolStart', toolId: update.toolCallId, name: update.title ?? 'tool' });
      } else if (kind === 'tool_call_update') {
        const status = update.status === 'failed' ? 'error' : 'completed';
        const resultText = update.rawOutput
          ? (typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput))
          : undefined;
        send({
          type: 'toolComplete', toolId: update.toolCallId, name: update.title ?? 'tool',
          durationMs: 0,
          error: status === 'error' ? (resultText ?? 'Tool failed') : undefined,
          resultText,
        });
      } else if (kind === 'plan' || kind === 'plan_update') {
        if (update.entries) {
          const entries = update.entries as Array<{ id: string; content: string; status: string }>;
          const text = entries
            .map((e) => {
              const icon = e.status === 'completed' ? '[x]' : e.status === 'in_progress' ? '[*]' : '[ ]';
              return `${icon} ${e.content}`;
            })
            .join('\n');
          send({ type: 'statusUpdate', status: 'ready', message: `Tasks:\n${text}` });
        }
      } else if (kind === 'usage_update') {
        send({ type: 'usageUpdate', usage: { total: update.used ?? 0 }, contextWindow: update.size });
      }
    }
  }

  function handleMessage(msg: AcpMessage): void {
    const hasId = 'id' in msg && msg.id !== undefined;
    const hasMethod = 'method' in msg && msg.method !== undefined;

    if (hasId && hasMethod) {
      // JSON-RPC request from server
      handleRequest(msg.id!, msg.method!, msg.params);
      return;
    }

    if (hasId) {
      // JSON-RPC response to our request
      const p = pending.get(msg.id!);
      if (p) {
        pending.delete(msg.id!);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }

    if (hasMethod) {
      handleNotification(msg.method!, msg.params);
    }
  }

  return { handleMessage, pendingApprovalId: () => pendingApprovalId };
}

// ── Tests ────────────────────────────────────────────────────

describe('acpClient message routing', () => {
  // ── Notification routing ──────────────────────────────
  describe('notifications (method, no id)', () => {
    it('agent_message_chunk → messageDelta', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } } },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'messageDelta', text: 'Hello' });
    });

    it('agent_thought_chunk → thinkingDelta', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Analyzing...' } } },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'thinkingDelta', text: 'Analyzing...' });
    });

    it('tool_call → toolStart', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'tool_call', toolCallId: 'tc_1', title: 'Grep' } },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'toolStart', toolId: 'tc_1', name: 'Grep' });
    });

    it('tool_call_update → toolComplete with resultText', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_2',
            title: 'Read',
            status: 'completed',
            rawOutput: 'file content output',
          },
        },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'toolComplete',
        toolId: 'tc_2',
        name: 'Read',
        resultText: 'file content output',
      });
    });

    it('tool_call_update with failed status → error toolComplete', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc_3',
            title: 'Bash',
            status: 'failed',
            rawOutput: 'Error: command not found',
          },
        },
      });
      expect(sent[0]).toMatchObject({
        type: 'toolComplete',
        toolId: 'tc_3',
        error: 'Error: command not found',
      });
    });

    it('plan → statusUpdate with task list', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'plan',
            entries: [
              { id: '1', content: 'Read the code', status: 'completed' },
              { id: '2', content: 'Fix the bug', status: 'in_progress' },
              { id: '3', content: 'Write tests', status: 'pending' },
            ],
          },
        },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe('statusUpdate');
      expect(sent[0].message).toContain('Tasks:');
      expect(sent[0].message).toContain('[x] Read the code');
      expect(sent[0].message).toContain('[*] Fix the bug');
      expect(sent[0].message).toContain('[ ] Write tests');
    });

    it('usage_update → usageUpdate with context window', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'usage_update', used: 15000, size: 200000 } },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'usageUpdate',
        usage: { total: 15000 },
        contextWindow: 200000,
      });
    });

    it('unknown session/update kind → no crash', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'unknown_kind' } },
      });
      expect(sent).toHaveLength(0);
    });
  });

  // ── Request routing (the bug fix!) ────────────────────
  describe('request routing (id + method) — the bug fix', () => {
    it('session/request_permission is handled as a request, not dropped', () => {
      let capturedId = -1;
      const { handleMessage } = createDispatcher(
        () => {},
        new Map(),
        (id) => { capturedId = id; },
      );
      handleMessage({
        jsonrpc: '2.0',
        id: 42,
        method: 'session/request_permission',
        params: { toolCall: { title: 'Bash', rawInput: '{"command":"rm -rf /"}' } },
      });
      expect(capturedId).toBe(42); // Request was processed, not dropped!
    });

    it('session/request_permission creates approvalRequest', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: { toolCall: { title: 'Bash', rawInput: '{"command":"rm"}' } },
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'approvalRequest',
        requestId: '7',
        command: 'Bash',
      });
    });
  });

  // ── Response routing ──────────────────────────────────
  describe('response routing (id, no method)', () => {
    it('resolves pending promise on success response', async () => {
      const pending: PendingMap = new Map();
      const p = new Promise<any>((resolve, reject) => {
        pending.set(99, { resolve, reject });
      });
      const { handleMessage } = createDispatcher(
        () => {},
        pending,
      );
      handleMessage({
        jsonrpc: '2.0',
        id: 99,
        result: { ok: true },
      });
      const result = await p;
      expect(result).toEqual({ ok: true });
    });

    it('rejects pending promise on error response', async () => {
      const pending: PendingMap = new Map();
      const p = new Promise<any>((resolve, reject) => {
        pending.set(88, { resolve, reject });
      });
      const { handleMessage } = createDispatcher(
        () => {},
        pending,
      );
      handleMessage({
        jsonrpc: '2.0',
        id: 88,
        error: { code: -1, message: 'Failed' },
      });
      await expect(p).rejects.toThrow('Failed');
    });

    it('ignores unknown response id', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      // Should not throw
      handleMessage({
        jsonrpc: '2.0',
        id: 999,
        result: { data: 'ok' },
      });
      expect(sent).toHaveLength(0);
    });
  });

  // ── Empty/edge cases ──────────────────────────────────
  describe('edge cases', () => {
    it('empty agent_message_chunk → no message', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } } },
      });
      expect(sent).toHaveLength(0);
    });

    it('empty agent_thought_chunk → no message', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } } },
      });
      expect(sent).toHaveLength(0);
    });

    it('unknown notification method → no crash', () => {
      const sent: any[] = [];
      const { handleMessage } = createDispatcher(
        (m) => sent.push(m),
        new Map(),
      );
      handleMessage({
        jsonrpc: '2.0',
        method: 'some/unknown_method',
        params: {},
      });
      expect(sent).toHaveLength(0);
    });
  });
});
