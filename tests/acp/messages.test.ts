/**
 * ACP Message contract tests — verifies the agent-server protocol
 * without a real QueryEngine. Uses the SDK's in-process connection.
 */

import { describe, it, expect } from 'vitest';
import { agent, client } from '@agentclientprotocol/sdk';
import type { SessionNotification } from '@agentclientprotocol/sdk';

describe('ACP Message Contract', () => {
  describe('session/new', () => {
    it('should create session via ClientContext.buildSession', async () => {
      const app = agent({ name: 'test' });
      app.onRequest('session/new', async () => ({
        sessionId: 'test-session-1',
        modes: {
          currentModeId: 'ask',
          availableModes: [{ id: 'ask', name: 'Ask', description: 'Ask before each tool' }],
        },
      }));

      const cl = client({ name: 'test-client' });
      await cl.connectWith(app, async (ctx) => {
        const session = await ctx.buildSession('/tmp/test').start();
        expect(session.sessionId).toBe('test-session-1');
        session.dispose();
      });
    });
  });

  describe('session/prompt', () => {
    it('should stream updates and return stop reason', async () => {
      const app = agent({ name: 'test' });
      app.onRequest('session/new', async () => ({
        sessionId: 's1',
        modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask', description: '' }] },
      }));
      app.onRequest('session/prompt', async ({ client }) => {
        await client.notify('session/update', {
          sessionId: 's1',
          update: { sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text', text: 'Hello World' } },
        } satisfies SessionNotification);
        return { stopReason: 'end_turn' as const };
      });

      const cl = client({ name: 'test-client' });
      const updates: any[] = [];
      cl.onNotification('session/update', ({ params }) => { updates.push(params); });

      await cl.connectWith(app, async (ctx) => {
        const session = await ctx.buildSession('/tmp/test').start();
        const stop = await session.prompt('Hi');
        expect(stop.stopReason).toBe('end_turn');
        expect(updates.length).toBeGreaterThanOrEqual(1);
        expect(updates[0].update.content.text).toBe('Hello World');
        session.dispose();
      });
    });

    it('should reject prompt for unknown session', async () => {
      const app = agent({ name: 'test' });
      app.onRequest('session/prompt', async ({ params }) => {
        if (params.sessionId !== 'known') throw new Error('Session not found');
        return { stopReason: 'end_turn' as const };
      });

      const cl = client({ name: 'test-client' });
      await cl.connectWith(app, async (ctx) => {
        await expect(
          ctx.request('session/prompt', {
            sessionId: 'unknown',
            prompt: [{ type: 'text', text: 'Hi' }],
          } as any),
        ).rejects.toThrow();  // SDK wraps errors as Internal error
      });
    });
  });

  describe('session/cancel', () => {
    it('should be accepted as a notification from client', async () => {
      let cancelled = false;
      const app = agent({ name: 'test' });
      app.onNotification('session/cancel', async () => { cancelled = true; });

      const cl = client({ name: 'test-client' });
      await cl.connectWith(app, async (ctx) => {
        await ctx.notify('session/cancel', { sessionId: 's1' } as any);
        // Let microtasks settle
        await new Promise((r) => setTimeout(r, 10));
        expect(cancelled).toBe(true);
      });
    });
  });

  describe('session/request_permission', () => {
    it('should round-trip permission request and response', async () => {
      const app = agent({ name: 'test' });
      app.onRequest('session/new', async () => ({
        sessionId: 's1', modes: undefined,
      }));
      app.onRequest('session/prompt', async ({ client }) => {
        const resp = await client.request('session/request_permission', {
          sessionId: 's1',
          toolCall: { toolCallId: 't1', title: 'Run bash', status: 'in_progress', rawInput: 'ls' },
          options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
        } as any);
        return { stopReason: resp.outcome.outcome === 'selected' ? 'end_turn' : 'cancelled' as any };
      });

      const cl = client({ name: 'test-client' });
      cl.onRequest('session/request_permission', async () => ({
        outcome: { outcome: 'selected', optionId: 'allow_once' } as any,
      }));

      await cl.connectWith(app, async (ctx) => {
        const session = await ctx.buildSession('/tmp/test').start();
        const stop = await session.prompt('Do something');
        expect(stop.stopReason).toBe('end_turn');
        session.dispose();
      });
    });
  });
});
